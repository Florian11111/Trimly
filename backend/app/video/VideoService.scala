package video

import play.api.libs.Files.TemporaryFile
import play.api.mvc.MultipartFormData
import scala.concurrent.{ExecutionContext, Future}
import java.io.File
import java.nio.file.{Paths, Path}
import scala.util.{Random, Success, Failure, Try}
import javax.inject._
import scala.concurrent.duration._
import org.apache.pekko.actor.ActorSystem

import video.FFmpegUtils
import video.VideoInfo
import video.VideoConversion

@Singleton
class VideoService @Inject()(actorSystem: ActorSystem)(implicit ec: ExecutionContext) {

  private val uploadDir = new File(System.getProperty("java.io.tmpdir"))
  private val processedDir = new File(uploadDir, "processed_videos")

  if (!processedDir.exists()) processedDir.mkdir()


  def scheduleDeleteAfterDelay(filepath: String, filePathReady: String): Unit = {
    // delete filepath now
    val file = new File(filepath)
    if (file.exists()) {
      file.delete()
      println(s"Deleted file ${file.getName}.")
    }
    // delete filePathReady after 1 minute
    actorSystem.scheduler.scheduleOnce(1.minutes) {
      val readyFile = new File(filePathReady)
      if (readyFile.exists()) {
        readyFile.delete()
        println(s"Deleted ready file ${readyFile.getName}.")
      } else {
        println(s"Ready file ${readyFile.getName} does not exist, nothing to delete.")
      }
    }
  }

  def handleUpload(data: MultipartFormData[TemporaryFile], video: MultipartFormData.FilePart[TemporaryFile]): Future[Either[String, String]] = {
    val startTime = data.dataParts.get("startTime").flatMap(_.headOption).flatMap(s => Try(s.toInt).toOption)
    val endTime   = data.dataParts.get("endTime").flatMap(_.headOption).flatMap(s => Try(s.toInt).toOption)
    val volume    = data.dataParts.get("volume").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption).getOrElse(1.0)
    val maxSizeMb = data.dataParts.get("maxSizeMb").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption).getOrElse(-1.0)
    val width     = data.dataParts.get("width").flatMap(_.headOption).flatMap(s => Try(s.toInt).toOption)
    val height    = data.dataParts.get("height").flatMap(_.headOption).flatMap(s => Try(s.toInt).toOption)
    val framerate = data.dataParts.get("framerate").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption)
    
    // add 10 random characters to the filename
    val randomSuffix = Random.alphanumeric.take(10).mkString
    val filename = s"${video.filename.stripSuffix(".mp4")}_$randomSuffix.mp4"
    val filenameReady = s"${filename.stripSuffix(".mp4")}_r.mp4"
    val outputFile = new File(processedDir, filename)
    
    video.ref.moveTo(outputFile, replace = true)
    if (!outputFile.exists()) {
      return Future.successful(Left(s"Failed to move uploaded file to processed directory: ${outputFile.getAbsolutePath}"))
    }
    println("successfully moved file to processed directory: " + outputFile.getAbsolutePath)
    val conversionInfo = VideoConversion(
      filePath = outputFile.getAbsolutePath,
      filePathReady = processedDir.getAbsolutePath + File.separator + filenameReady,
      startTime = startTime,
      endTime = endTime,
      bitrate = data.dataParts.get("bitrate").flatMap(_.headOption).flatMap(s => Try(s.toLong).toOption),
      framerate = framerate,
      width = width,
      height = height,
      volume = Some(volume)
    )

    println(s"Processing video: $filename with conversion info: $conversionInfo")
    VideoCalculator.process(conversionInfo).map {
      case Right(_) =>
        scheduleDeleteAfterDelay(conversionInfo.filePath, conversionInfo.filePathReady)
        Right(filename)
      case Left(error) =>
        println(s"Error processing video: $error")
        Left(error)
    }
  }

  def checkVideoExists(filename: String): Boolean = {
    val file = new File(processedDir, filename)
    file.exists()
  }

  def getProcessedVideoFile(filename: String): Option[File] = {
    val file = new File(processedDir, filename)
    if (file.exists()) Some(file) else None
  }
}
