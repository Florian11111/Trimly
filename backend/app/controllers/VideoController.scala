package controllers

import javax.inject._
import play.api.mvc._
import play.api.libs.json._
import play.api.libs.Files.TemporaryFile
import scala.concurrent.{ExecutionContext, Future}
import scala.sys.process._
import java.io.File
import java.nio.file.{Paths, Path}

@Singleton
class VideoController @Inject()(val controllerComponents: ControllerComponents)(implicit ec: ExecutionContext) extends BaseController {

  private val uploadDir = new File(System.getProperty("java.io.tmpdir"))
  private val processedDir = new File(System.getProperty("java.io.tmpdir"), "processed_videos")

  if (!processedDir.exists()) {
    processedDir.mkdir()
  }

  def upload: Action[MultipartFormData[TemporaryFile]] = Action.async(parse.multipartFormData) { request =>
    println("Received upload request.")
    
    request.body.file("video").map { video =>
      val filename = Paths.get(video.filename).getFileName.toString
      val tempPath = Paths.get(System.getProperty("java.io.tmpdir")).resolve(filename)
      println(s"Saving video to: $tempPath")
      video.ref.copyTo(tempPath, replace = true)

      val startTime = request.body.dataParts.get("startTime").flatMap(_.headOption).map(_.toLong).getOrElse(0L)
      val endTime = request.body.dataParts.get("endTime").flatMap(_.headOption).map(_.toLong).getOrElse(0L)

      println(s"Video file received: $filename")
      println(s"Start time: $startTime, End time: $endTime")

      // Get video duration and print it to the server log
      val videoDuration = getVideoDurationMs(tempPath.toString).getOrElse(0L)
      println(s"Video duration: $videoDuration ms")

      val processedVideoPath = processVideo(tempPath.toString, startTime, endTime)

      if (processedVideoPath.isDefined) {
        val processedFilename = processedVideoPath.get.getName
        Future.successful(Ok(Json.obj(
          "status" -> "success",
          "filename" -> filename,
          "startTime" -> startTime,
          "endTime" -> endTime,
          "message" -> "File uploaded and times extracted successfully",
          "processedVideo" -> s"/download/$processedFilename"
        )))
      } else {
        Future.successful(InternalServerError(Json.obj(
          "status" -> "error",
          "message" -> "Error processing video"
        )))
      }
    }.getOrElse {
      println("Missing file in the request.")
      Future.successful(BadRequest("Missing file"))
    }
  }

  def processVideo(videoPath: String, startTimeMs: Long, endTimeMs: Long): Option[File] = {
    val outputFilePath = processedDir.toPath.resolve(Paths.get(videoPath).getFileName.toString.replace(".mp4", "_processed.mp4")).toString
    val escapedVideoPath = s""""$videoPath""""
    val escapedOutputFilePath = s""""$outputFilePath""""

    // Get video duration with ffprobe
    val durationInMs: Long = {
      val ffprobeCommand = Seq(
        "C:\\Users\\flori\\Documents\\ffmpeg\\bin\\ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        videoPath
      )

      try {
        val durationSecStr = ffprobeCommand.!!.trim
        (durationSecStr.toDouble * 1000).toLong
      } catch {
        case e: Exception =>
          println(s"Error getting video duration: ${e.getMessage}")
          return None
      }
    }

    // Begrenzung von Endzeit auf Videolänge
    val adjustedEndMs = math.min(endTimeMs, durationInMs)
    val startSeconds = startTimeMs / 1000.0
    val endSeconds = adjustedEndMs / 1000.0

    val ffmpegCommand = Seq(
      "C:\\Users\\flori\\Documents\\ffmpeg\\bin\\ffmpeg",
      "-y",
      "-ss", startSeconds.toString,
      "-to", endSeconds.toString,
      "-i", videoPath,
      "-c:v", "libx264",
      "-c:a", "aac",
      "-strict", "experimental",
      outputFilePath
    )

    val result = ffmpegCommand.!(ProcessLogger(_ => (), _ => ())) // suppress output

    if (result == 0) {
      println(s"Video successfully processed: $outputFilePath")
      Some(new File(outputFilePath))
    } else {
      println(s"Error processing video. Exit code: $result")
      None
    }
  }

  def download(filename: String): Action[AnyContent] = Action {
    val file = new File(processedDir, filename)

    if (file.exists()) {
      println(s"File found for download: $filename")
      Ok.sendFile(file, inline = false)
    } else {
      println(s"File not found: $filename")
      NotFound("File not found.")
    }
  }

  // Helper method to get video duration in milliseconds
  def getVideoDurationMs(videoPath: String): Option[Long] = {
    val ffprobeCommand = Seq(
      "C:\\Users\\flori\\Documents\\ffmpeg\\bin\\ffprobe",
      "-v", "error",
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
}
