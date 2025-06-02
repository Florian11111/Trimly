package video

import java.io.File
import scala.sys.process._
import scala.util.Random
import java.nio.file.Paths
import upickle.default._
import scala.util.matching.Regex


object FFmpegUtils {

  private val ffmpegPath = "ffmpeg"
  private val ffprobePath = "ffprobe"

  def getVideoInfo(filepath: String): Option[Map[String, Any]] = {
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

      Some(Map(
        "duration" -> durationDouble,
        "bit_rate" -> bitRateLong,
        "size" -> sizeLong,
        "width" -> width.getOrElse(0),
        "height" -> height.getOrElse(0),
        "fps" -> fps,
        "stream_bit_rate" -> streamBitRateInt
      ))

    } catch {
      case e: Exception =>
        println(s"Error getting info: ${e.getMessage}")
        None
    }
  }


  def processVideo(
    videoPath: String,
    startTimeMs: Long,
    endTimeMs: Long,
    volumeFactor: Double,
    outputDir: File,
    framerate: Option[Double] = None,
    bitrate: Option[Long] = None,
    width: Option[Int] = None,
    height: Option[Int] = None
  ): Option[File] = {

    val randomSuffix = Random.alphanumeric.take(8).mkString
    val filenameWithRandomSuffix = Paths.get(videoPath).getFileName.toString.replace(".mp4", s"_$randomSuffix.mp4")
    val outputFilePath = outputDir.toPath.resolve(filenameWithRandomSuffix).toString

    val startSeconds = startTimeMs / 1000.0
    val endSeconds = endTimeMs / 1000.0

    // Dynamische Filter: Videoauflösung
    val resolutionFilter = (width, height) match {
      case (Some(w), Some(h)) =>
        println(s"Resolution Filter: scale=$w:$h")
        Some(s"scale=$w:$h")
      case _ =>
        println("No resolution filter applied.")
        None
    }

    // Kombiniere ggf. mehrere Filter in -vf
    val videoFilters = List(resolutionFilter).flatten
    val vfArgs = if (videoFilters.nonEmpty) Seq("-vf", videoFilters.mkString(",")) else Seq()

    // Framerate und Bitrate-Argumente
    val framerateArgs = framerate.map(r => Seq("-r", r.toString)).getOrElse(Seq())
    val bitrateArgs = bitrate.map(b => Seq("-b:v", b.toString)).getOrElse(Seq())

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

    //println(s"FFmpeg Command: ${ffmpegCommand.mkString(" ")}")
    /*
    val result = ffmpegCommand.!(ProcessLogger(
      line => println(s"FFmpeg Output: $line"),
      line => println(s"FFmpeg Error: $line")
      ))
    */
    
    val result = ffmpegCommand.!(ProcessLogger(_ => (), _ => ()))
    //println(s"FFmpeg exit code: $result")

    if (result == 0) {
      //println(s"Video processed successfully. Output file: $outputFilePath")
      Some(new File(outputFilePath))
    } else {
      println(s"Error processing video. Exit code: $result")
      None
    }
  }

}
