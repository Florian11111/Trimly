package video

import play.api.libs.Files.TemporaryFile
import play.api.mvc.MultipartFormData
import scala.concurrent.{ExecutionContext, Future}
import java.io.File
import java.nio.file.{Paths, Path}
import scala.util.{Random, Success, Failure, Try}
import javax.inject._
import video.FFmpegUtils
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

  def handleUpload(
    data: MultipartFormData[TemporaryFile],
    video: MultipartFormData.FilePart[TemporaryFile]
  ): Future[Either[String, UploadResult]] = Future {
    val filename = Paths.get(video.filename).getFileName.toString
    val tempDir = new File(uploadDir, s"upload_${Random.alphanumeric.take(8).mkString}")
    if (!tempDir.exists()) tempDir.mkdir()

    val tempPath = tempDir.toPath.resolve(filename)
    video.ref.copyTo(tempPath.toFile, replace = true)

    val startTime = data.dataParts.get("startTime").flatMap(_.headOption).flatMap(s => Try(s.toLong).toOption).getOrElse(0L)
    val endTime   = data.dataParts.get("endTime").flatMap(_.headOption).flatMap(s => Try(s.toLong).toOption).getOrElse(0L)
    val volume    = data.dataParts.get("volume").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption).getOrElse(1.0)
    val maxSizeMb = data.dataParts.get("maxSizeMb").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption)
    val bitrate   = data.dataParts.get("bitrate").flatMap(_.headOption).flatMap(s => Try(s.toLong).toOption)
    val framerate = data.dataParts.get("framerate").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption)

    val (widthOpt, heightOpt) = data.dataParts.get("resolution")
      .flatMap(_.headOption)
      .flatMap(s => s.split("x").map(_.toIntOption).toList match {
        case List(Some(w), Some(h)) => Some((Some(w), Some(h)))
        case _ => None
      }).getOrElse((None, None))

    val params = VideoCalculator.ProcessingParams(
      startTimeMs = startTime,
      endTimeMs = endTime,
      volumeFactor = volume,
      framerate = framerate,
      bitrate = bitrate,
      width = widthOpt,
      height = heightOpt,
      maxSizeMb = maxSizeMb
    )

    val outputDir = processedDir
    println(s"Processing video: $filename with params: $params")
    VideoCalculator.process(
      inputFile = tempPath.toFile,
      outputDir = outputDir,
      params = params
    ) match {
      case Right(processedFile) =>
        scheduleDeleteAfterDelay(processedFile)
        println(s"Video processed successfully: ${processedFile.getName}")
        Right(
          UploadResult(
            status = "ok",
            filename = processedFile.getName,
            startTime = startTime,
            endTime = endTime,
            volume = volume,
            message = "Video processed successfully.",
            processedVideo = processedFile.getName
          )
        )
      case Left(error) =>
        Left(error)
    }
  }

   def getProcessedVideoFile(filename: String): Option[File] = {
      println(s"Looking for processed video file: $filename")
      val file = new File(processedDir, filename)
      if (file.exists()) Some(file) else None
    }

}