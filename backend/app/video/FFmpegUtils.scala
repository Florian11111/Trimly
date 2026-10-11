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

      // Aus Format:
      val duration = format.obj.get("duration").map(_.str)
      val bit_rate = format.obj.get("bit_rate").map(_.str)
      val size = format.obj.get("size").map(_.str)

      // Video-Stream suchen
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


  // NVENC verfügbar? Einmal beim ersten Zugriff testen. Der Testlauf wärmt
  // gleichzeitig CUDA auf (der erste GPU-Job im Container ist sonst ~7s langsamer).
  // TRIMLY_ENCODER=cpu erzwingt CPU-Encoding.
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

  private def runFfmpeg(command: Seq[String]): Either[String, String] = {
    println(s"ffmpeg befehl: $command")
    // Letzte stderr-Zeilen merken, damit Fehler im Frontend erklärt werden können
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

  // Nur schneiden, Video wird 1:1 kopiert. Sehr schnell, aber der Start
  // springt auf den vorherigen Keyframe. Audio wird nur bei Lautstärkeänderung neu kodiert.
  def trimVideo(videoConversion: VideoConversion): Either[String, String] = {
    val startSeconds = videoConversion.startTime.getOrElse(0) / 1000.0
    val endSeconds = videoConversion.endTime.getOrElse(0) / 1000.0
    val volume = videoConversion.volume.getOrElse(1.0)
    if (volume < 0) return Left("Volume must be a non-negative number.")

    val audioArgs =
      if (videoConversion.removeAudio) Seq("-an")
      else if (volume == 1.0) Seq("-map", "0:a?", "-c:a", "copy")
      else Seq("-map", "0:a?", "-filter:a", s"volume=$volume", "-c:a", "aac", "-b:a", "192k")

    runFfmpeg(Seq(
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

  def processVideo(
    videoConversion: VideoConversion,
  ): Either[String, String] = {
    if (gpuAvailable) {
      processVideoWith(videoConversion, useGpu = true) match {
        case Left(error) =>
          // z.B. Codec, den NVDEC nicht kann (10-bit, AV1 auf älteren Karten) -> CPU
          println(s"[FFMPEG] GPU fehlgeschlagen, nutze CPU: $error")
          processVideoWith(videoConversion, useGpu = false)
        case ok if exceedsSizeLimit(videoConversion) =>
          // NVENC kann sehr niedrige Bitraten nicht erreichen (QP max. 51), libx264 schon
          println(s"[FFMPEG] GPU-Ergebnis über Größenlimit, kodiere mit CPU neu")
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

    // Dynamische Filter: Videoauflösung
    val resolutionFilter = (videoConversion.width, videoConversion.height) match {
      case (Some(w), Some(h)) =>
        // Encoder brauchen gerade Abmessungen (z.B. bei Custom-Auflösung)
        val scaler = if (useGpu) "scale_cuda" else "scale"
        Some(s"$scaler=${w - w % 2}:${h - h % 2}")
      case _ =>
        return Left("Width and height must be specified for resolution filter.")
    }

    // Kombiniere ggf. mehrere Filter in -vf
    val videoFilters = List(resolutionFilter).flatten
    val vfArgs = if (videoFilters.nonEmpty) Seq("-vf", videoFilters.mkString(",")) else Seq()

    // Framerate und Bitrate-Argumente
    val framerateArgs = videoConversion.framerate match {
      case Some(fps) => Seq("-r", fps.toString)
      case None => return Left("Framerate must be specified.")
    }
    val bitrateArgs = videoConversion.bitrate match {
      // Bei Größenlimit Spitzen begrenzen, damit die Zielgröße eingehalten wird
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

    // GPU: dekodieren, skalieren und kodieren komplett auf der Grafikkarte.
    // -bf 0: NVENC mit B-Frames erzeugt in ffmpeg 5.1 bei 29.97-fps-Quellen um ~100s
    // verschobene Zeitstempel, viele Player zeigen dann nur ein graues Bild.
    val hwaccelArgs = if (useGpu) Seq("-hwaccel", "cuda", "-hwaccel_output_format", "cuda") else Seq()
    val encoderArgs =
      if (useGpu) Seq("-c:v", "h264_nvenc", "-preset", "p4", "-bf", "0")
      else Seq("-c:v", "libx264", "-preset", "veryfast")

    runFfmpeg(Seq(
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
