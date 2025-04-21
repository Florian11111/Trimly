package video

import play.api.libs.Files.TemporaryFile
import play.api.mvc.MultipartFormData
import scala.concurrent.{ExecutionContext, Future}
import java.io.File
import java.nio.file.{Paths, Path}
import scala.util.{Random, Success, Failure}
import javax.inject._
import video.FFmpegUtils
import scala.concurrent.duration._ 
import scala.concurrent.duration._
import org.apache.pekko.actor.ActorSystem


@Singleton
class VideoService @Inject()(actorSystem: ActorSystem)(implicit ec: ExecutionContext) {

  private val uploadDir = new File(System.getProperty("java.io.tmpdir"))
  private val processedDir = new File(uploadDir, "processed_videos")

  if (!processedDir.exists()) processedDir.mkdir()

  def scheduleDeleteAfterDelay(file: File): Unit = {
    actorSystem.scheduler.scheduleOnce(1.minutes) {
      val deleted = file.delete()
      if (deleted) {
        println(s"Deleted file ${file.getName}.")
      } else {
        println(s"Failed to delete file ${file.getName}.")
      }
    }
  }

  def handleUpload(data: MultipartFormData[TemporaryFile], video: MultipartFormData.FilePart[TemporaryFile]): Future[Either[String, UploadResult]] = Future {
    val filename = Paths.get(video.filename).getFileName.toString
    val tempDir = new File(uploadDir, s"upload_${Random.alphanumeric.take(8).mkString}")
    if (!tempDir.exists()) tempDir.mkdir()

    val tempPath = tempDir.toPath.resolve(filename)
    video.ref.copyTo(tempPath.toFile, replace = true)

    val startTime = data.dataParts.get("startTime").flatMap(_.headOption).map(_.toLong).getOrElse(0L)
    val endTime = data.dataParts.get("endTime").flatMap(_.headOption).map(_.toLong).getOrElse(0L)
    val volume = data.dataParts.get("volume").flatMap(_.headOption).map(_.toDouble).getOrElse(1.0)

    val videoDuration = FFmpegUtils.getVideoDurationMs(tempPath.toString).getOrElse(0L)

    if (startTime < 0)
      Left("Start time must be non-negative.")
    else if (startTime > endTime)
      Left("Start time must be less than or equal to end time.")
    else if (endTime > videoDuration)
      Left(s"End time must be less than video duration (${videoDuration} ms).")
    else {
      val processed = FFmpegUtils.processVideo(tempPath.toString, startTime, endTime, volume, processedDir)
      processed match {
        case Some(file) =>
          scheduleDeleteAfterDelay(file)
          Right(UploadResult(
            status = "success",
            filename = filename,
            startTime = startTime,
            endTime = endTime,
            volume = volume,
            message = "File uploaded and processed successfully",
            processedVideo = s"/download/${file.getName}"
          ))
        case None => Left("Error processing video")
      }
    }
  }

  def getProcessedVideoFile(filename: String): Option[File] = {
    val file = new File(processedDir, filename)
    if (file.exists()) Some(file) else None
  }
}
