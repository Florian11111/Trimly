package video

import java.io.File
import scala.sys.process._
import scala.util.Random
import java.nio.file.Paths

object FFmpegUtils {

  private val ffmpegPath = "C:\\Users\\flori\\Documents\\ffmpeg\\bin\\ffmpeg"
  private val ffprobePath = "C:\\Users\\flori\\Documents\\ffmpeg\\bin\\ffprobe"

  def getVideoDurationMs(videoPath: String): Option[Long] = {
    val ffprobeCommand = Seq(
      ffprobePath, "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath
    )

    try {
      val durationSecStr = ffprobeCommand.!!.trim
      Some((durationSecStr.toDouble * 1000).toLong)
    } catch {
      case e: Exception =>
        println(s"Error getting video duration: ${e.getMessage}")
        None
    }
  }

  def processVideo(videoPath: String, startTimeMs: Long, endTimeMs: Long, volumeFactor: Double, outputDir: File): Option[File] = {
    val randomSuffix = Random.alphanumeric.take(8).mkString
    val filenameWithRandomSuffix = Paths.get(videoPath).getFileName.toString.replace(".mp4", s"_$randomSuffix.mp4")
    val outputFilePath = outputDir.toPath.resolve(filenameWithRandomSuffix).toString

    val startSeconds = startTimeMs / 1000.0
    val endSeconds = endTimeMs / 1000.0

    val ffmpegCommand = Seq(
      ffmpegPath,
      "-y",
      "-ss", startSeconds.toString,
      "-to", endSeconds.toString,
      "-i", videoPath,
      "-filter:a", s"volume=$volumeFactor",
      "-c:v", "libx264",
      "-c:a", "aac",
      "-strict", "experimental",
      outputFilePath
    )

    val result = ffmpegCommand.!(ProcessLogger(_ => (), _ => ()))

    if (result == 0) Some(new File(outputFilePath)) else {
      println(s"Error processing video. Exit code: $result")
      None
    }
  }
}
