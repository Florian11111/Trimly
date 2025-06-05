package video

import java.io.File
import scala.sys.process._
import scala.util.Random
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


  def processVideo(
    videoConversion: VideoConversion,
  ): Either[String, String] = {

    val videoPath = videoConversion.filePath
    val outputFilePath = videoConversion.filePathReady

    val startSeconds = videoConversion.startTime.getOrElse(0) / 1000.0
    val endSeconds = videoConversion.endTime.getOrElse(0) / 1000.0

    // Dynamische Filter: Videoauflösung
    val resolutionFilter = (videoConversion.width, videoConversion.height) match {
      case (Some(w), Some(h)) =>
        Some(s"scale=$w:$h")
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
      case Some(b) => Seq("-b:v", s"${b}k")
      case None => return Left("Bitrate must be specified.")
    }

    val volumeFactor = videoConversion.volume match {
      case Some(v) if v >= 0 => v.toString
      case _ => return Left("Volume must be a non-negative number.")
    }

    val ffmpegCommand = Seq(
      ffmpegPath,
      "-y",
      "-ss", startSeconds.toString,
      "-to", endSeconds.toString,
      "-i", videoPath,
      "-filter:a", s"volume=$volumeFactor"
    ) ++ vfArgs ++ framerateArgs ++ bitrateArgs ++ Seq(
      "-c:v", "libx264",
      "-c:a", "aac",
      "-strict", "experimental",
      "-f", "mp4",
      outputFilePath
    )
    println(s"ffmpeg befehl: $ffmpegCommand")
    val result = ffmpegCommand.!(ProcessLogger(_ => (), _ => ()))
    

    if (result == 0) {
      //println(s"Video processed successfully. Output file: $outputFilePath")
      Right("Video processed successfully.")
    } else {
      Left(s"FFmpeg processing failed with exit code $result.")
    }
  }

}
