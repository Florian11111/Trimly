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
    val maxSizeMb = data.dataParts.get("maxSizeMb").flatMap(_.headOption).flatMap(s => scala.util.Try(s.toDouble).toOption).getOrElse(-1.0)

    val resolution = data.dataParts.get("resolution")
    .flatMap(_.headOption)
    .flatMap(s => s.split("x").map(_.toIntOption).toList match {
        case List(Some(w), Some(h)) => Some((w, h))
        case _ => None
    })


    val videoDuration = FFmpegUtils.getVideoDurationMs(tempPath.toString).getOrElse(0L)

    if (startTime < 0)
      Left("Start time must be non-negative.")
    else if (startTime > endTime)
      Left("Start time must be less than or equal to end time.")
    else if (endTime > videoDuration)
      Left(s"End time must be less than video duration (${videoDuration} ms).")
    else {
      // Schritt 1: Video zuschneiden
      val trimmedVideo = FFmpegUtils.processVideo(tempPath.toString, startTime, endTime, volume, processedDir, resolution.map(r => r._1), resolution.map(r => r._2))

      trimmedVideo match {
        case Some(trimmedFile: File) =>  // Sicherstellen, dass es sich um ein File handelt
          // Schritt 2: Überprüfen, ob das Video bereits klein genug ist
          val fileSizeMb = trimmedFile.length() / (1024.0 * 1024.0)  // Umrechnung in MB

          if (maxSizeMb != -1 && fileSizeMb > maxSizeMb) {
            val compressedVideo = FFmpegUtils.compressVideo(trimmedFile.getAbsolutePath, maxSizeMb, processedDir)
            
            compressedVideo match {
              case Some(compressedFile: File) =>  // Sicherstellen, dass es sich um ein File handelt
                scheduleDeleteAfterDelay(compressedFile)
                Right(UploadResult(
                  status = "success",
                  filename = filename,
                  startTime = startTime,
                  endTime = endTime,
                  volume = volume,
                  message = "File uploaded, trimmed, and compressed successfully",
                  processedVideo = s"/download/${compressedFile.getName}"
                ))
              case None =>
                Left("Error compressing video")
            }
          } else {
            // Kein Komprimieren nötig, Video ist klein genug
            scheduleDeleteAfterDelay(trimmedFile)
            Right(UploadResult(
              status = "success",
              filename = filename,
              startTime = startTime,
              endTime = endTime,
              volume = volume,
              message = "File uploaded and trimmed successfully",
              processedVideo = s"/download/${trimmedFile.getName}"
            ))
          }
        case None => Left("Error processing video")
      }
    }
}


  def getProcessedVideoFile(filename: String): Option[File] = {
    val file = new File(processedDir, filename)
    if (file.exists()) Some(file) else None
  }
}
