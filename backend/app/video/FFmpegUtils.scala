package video

import java.io.File
import scala.sys.process._
import scala.util.{Random, Try}
import java.nio.file.Paths
import upickle.default._
import scala.util.matching.Regex
import video.VideoInfo
import video.VideoConversion

object FFmpegUtils {
  private val ffmpegPath = "ffmpeg"
  private val ffprobePath = "ffprobe"

  def getVideoInfo(filepath: String): Either[String, VideoInfo] = {

    val ffprobeCmd = Seq(
      "ffprobe", 
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filepath
    )

    try {
      val output = ffprobeCmd.!!
      val json = ujson.read(output)

      val format = json("format")
      val streams = json("streams").arr

      // From the format:
      val duration = format.obj.get("duration").map(_.str)
      val bit_rate = format.obj.get("bit_rate").map(_.str)
      val size = format.obj.get("size").map(_.str)

      // Find the video stream
      val videoStreamOpt = streams.find { stream =>
        stream.obj.get("codec_type").exists(_.str == "video")
      }

      val width = videoStreamOpt.flatMap(_.obj.get("width").map(_.num.toInt))
      val height = videoStreamOpt.flatMap(_.obj.get("height").map(_.num.toInt))
      val stream_bit_rate = videoStreamOpt.flatMap(_.obj.get("bit_rate").map(_.str))
      
      val r_frame_rate = videoStreamOpt.flatMap(_.obj.get("r_frame_rate").map(_.str))

      val fps: Double = r_frame_rate.map { fpsStr =>
        val parts = fpsStr.split("/")
        if (parts.length == 2) parts(0).toDouble / parts(1).toDouble else fpsStr.toDouble
      }.getOrElse(0.0) 



      val durationDouble: Double = duration.flatMap(d => scala.util.Try(d.toDouble).toOption).getOrElse(0.0)
      val sizeLong: Long = size.flatMap(s => scala.util.Try(s.toLong).toOption).getOrElse(0L)
      val bitRateLong: Long = bit_rate.flatMap(b => scala.util.Try(b.toLong).toOption).getOrElse(0L)
      val streamBitRateInt: Int = stream_bit_rate.flatMap(b => scala.util.Try(b.toInt).toOption).getOrElse(0)
  
      // convert to VideoInfo 
      Right(VideoInfo(
        duration = durationDouble,
        bitRate = bitRateLong,
        size = sizeLong,
        width = width.getOrElse(0),
        height = height.getOrElse(0),
        fps = fps,
        streamBitRate = streamBitRateInt
      ))

    } catch {
      case e: Exception =>
        println(s"Error getting info: ${e.getMessage}")
        Left(s"Error getting video info: ${e.getMessage}")
    }
  }


  // Is NVENC available? Tested once on first use. The test run also warms up
  // CUDA (otherwise the first GPU job in the container is ~7 s slower).
  // TRIMLY_ENCODER=cpu forces CPU encoding.
  lazy val gpuAvailable: Boolean = {
    val forcedCpu = sys.env.get("TRIMLY_ENCODER").exists(_.equalsIgnoreCase("cpu"))
    val available = !forcedCpu && Try {
      Seq(
        ffmpegPath, "-v", "error",
        "-f", "lavfi", "-i", "color=size=640x360:duration=0.2",
        "-vf", "hwupload_cuda,scale_cuda=320:240",
        "-c:v", "h264_nvenc", "-f", "null", "-"
      ).!(ProcessLogger(_ => (), _ => ())) == 0
    }.getOrElse(false)
    println(s"[FFMPEG] Encoder: ${if (available) "GPU (h264_nvenc)" else "CPU (libx264)"}")
    available
  }

  def hasAudio(path: String): Boolean = Try {
    Seq(ffprobePath, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
      "-of", "csv=p=0", path).!!.trim.nonEmpty
  }.getOrElse(false)

  // Bitrate for audio-only exports (MP3)
  val AudioOnlyBitrateKbps = 192

  def run(command: Seq[String]): Either[String, String] = {
    println(s"[FFMPEG] Command: $command")
    // Keep the last stderr lines so errors can be explained in the frontend
    val stderrTail = scala.collection.mutable.Queue.empty[String]
    val result = command.!(ProcessLogger(_ => (), line => {
      stderrTail.enqueue(line)
      if (stderrTail.size > 5) stderrTail.dequeue()
    }))

    if (result == 0) {
      Right("Video processed successfully.")
    } else {
      Left(s"FFmpeg processing failed with exit code $result: ${stderrTail.mkString(" | ")}")
    }
  }

  // Trim only, the video is copied 1:1. Very fast, but the start
  // jumps to the previous keyframe. Audio is only re-encoded when the volume changes.
  def trimVideo(videoConversion: VideoConversion): Either[String, String] = {
    val startSeconds = videoConversion.startTime.getOrElse(0) / 1000.0
    val endSeconds = videoConversion.endTime.getOrElse(0) / 1000.0
    val volume = videoConversion.volume.getOrElse(1.0)
    if (volume < 0) return Left("Volume must be a non-negative number.")

    val audioArgs =
      if (videoConversion.removeAudio) Seq("-an")
      else if (volume == 1.0) Seq("-map", "0:a?", "-c:a", "copy")
      else Seq("-map", "0:a?", "-filter:a", s"volume=$volume", "-c:a", "aac", "-b:a", "192k")

    run(Seq(
      ffmpegPath,
      "-y",
      "-v", "error",
      "-ss", startSeconds.toString,
      "-to", endSeconds.toString,
      "-i", videoConversion.filePath,
      "-map", "0:v:0",
      "-c:v", "copy"
    ) ++ audioArgs ++ Seq(
      "-avoid_negative_ts", "make_zero",
      "-f", "mp4",
      videoConversion.filePathReady
    ))
  }

  // Only the audio of the selection as MP3
  def extractAudio(videoConversion: VideoConversion): Either[String, String] = {
    val startSeconds = videoConversion.startTime.getOrElse(0) / 1000.0
    val endSeconds = videoConversion.endTime.getOrElse(0) / 1000.0
    val volume = videoConversion.volume.getOrElse(1.0)
    if (volume < 0) return Left("Volume must be a non-negative number.")
    if (!hasAudio(videoConversion.filePath)) return Left("This video has no audio track.")

    run(Seq(
      ffmpegPath,
      "-y",
      "-v", "error",
      "-ss", startSeconds.toString,
      "-to", endSeconds.toString,
      "-i", videoConversion.filePath,
      "-map", "0:a:0",
      "-vn",
      "-filter:a", s"volume=$volume",
      "-c:a", "libmp3lame",
      "-b:a", s"${AudioOnlyBitrateKbps}k",
      "-f", "mp3",
      videoConversion.filePathReady
    ))
  }

  def processVideo(
    videoConversion: VideoConversion,
  ): Either[String, String] = {
    if (gpuAvailable) {
      processVideoWith(videoConversion, useGpu = true) match {
        case Left(error) =>
          // e.g. a codec NVDEC can't decode (10-bit, AV1 on older cards) -> CPU
          println(s"[FFMPEG] GPU fehlgeschlagen, nutze CPU: $error")
          processVideoWith(videoConversion, useGpu = false)
        case ok if exceedsSizeLimit(videoConversion) =>
          // NVENC can't reach very low bitrates (QP max. 51), libx264 can
          println(s"[FFMPEG] GPU result exceeds the size limit, re-encoding on the CPU")
          processVideoWith(videoConversion, useGpu = false)
        case ok => ok
      }
    } else {
      processVideoWith(videoConversion, useGpu = false)
    }
  }

  private def exceedsSizeLimit(videoConversion: VideoConversion): Boolean =
    videoConversion.maxSizeMb.exists { mb =>
      new File(videoConversion.filePathReady).length() > mb * 1024 * 1024
    }

  private def processVideoWith(
    videoConversion: VideoConversion,
    useGpu: Boolean
  ): Either[String, String] = {

    val videoPath = videoConversion.filePath
    val outputFilePath = videoConversion.filePathReady

    val startSeconds = videoConversion.startTime.getOrElse(0) / 1000.0
    val endSeconds = videoConversion.endTime.getOrElse(0) / 1000.0

    // Dynamic filters: video resolution
    val resolutionFilter = (videoConversion.width, videoConversion.height) match {
      case (Some(w), Some(h)) =>
        // Encoders need even dimensions (e.g. with a custom resolution)
        val scaler = if (useGpu) "scale_cuda" else "scale"
        Some(s"$scaler=${w - w % 2}:${h - h % 2}")
      case _ =>
        return Left("Width and height must be specified for resolution filter.")
    }

    // Kombiniere ggf. mehrere Filter in -vf
    val videoFilters = List(resolutionFilter).flatten
    val vfArgs = if (videoFilters.nonEmpty) Seq("-vf", videoFilters.mkString(",")) else Seq()

    // Frame rate and bitrate arguments
    val framerateArgs = videoConversion.framerate match {
      case Some(fps) => Seq("-r", fps.toString)
      case None => return Left("Framerate must be specified.")
    }
    val bitrateArgs = videoConversion.bitrate match {
      // With a size limit, cap peaks so the target size is met
      case Some(b) if videoConversion.maxSizeMb.isDefined =>
        Seq("-b:v", s"${b}k", "-maxrate", s"${b}k", "-bufsize", s"${b * 2}k")
      case Some(b) => Seq("-b:v", s"${b}k")
      case None => return Left("Bitrate must be specified.")
    }

    val volumeFactor = videoConversion.volume match {
      case Some(v) if v >= 0 => v.toString
      case _ => return Left("Volume must be a non-negative number.")
    }

    val audioArgs =
      if (videoConversion.removeAudio) Seq("-an")
      else Seq(
        "-filter:a", s"volume=$volumeFactor",
        "-c:a", "aac",
        "-b:a", s"${VideoCalculator.AudioBitrateKbps}k"
      )

    // GPU: decode, scale and encode entirely on the graphics card.
    // -bf 0: with B-frames, NVENC in ffmpeg 5.1 shifts timestamps by ~100 s for 29.97 fps
    // sources, and many players then show only a grey picture.
    val hwaccelArgs = if (useGpu) Seq("-hwaccel", "cuda", "-hwaccel_output_format", "cuda") else Seq()
    val encoderArgs =
      if (useGpu) Seq("-c:v", "h264_nvenc", "-preset", "p4", "-bf", "0")
      else Seq("-c:v", "libx264", "-preset", "veryfast")

    run(Seq(
      ffmpegPath,
      "-y",
      "-v", "error"
    ) ++ hwaccelArgs ++ Seq(
      "-ss", startSeconds.toString,
      "-to", endSeconds.toString,
      "-i", videoPath
    ) ++ audioArgs ++ vfArgs ++ framerateArgs ++ bitrateArgs ++ encoderArgs ++ Seq(
      "-strict", "experimental",
      "-f", "mp4",
      outputFilePath
    ))
  }

}
