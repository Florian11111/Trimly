package video

import javax.inject._
import play.api.mvc._
import play.api.libs.json._
import play.api.libs.Files.TemporaryFile
import scala.concurrent.{ExecutionContext, Future}
import java.io.File

import video.VideoService

@Singleton
class VideoController @Inject()(
  val controllerComponents: ControllerComponents,
  videoService: VideoService
)(implicit ec: ExecutionContext) extends BaseController {

  // Original speichern, ID zurückgeben
  def store: Action[MultipartFormData[TemporaryFile]] = Action(parse.multipartFormData) { request =>
    request.body.file("video") match {
      case Some(video) =>
        val id = videoService.storeOriginal(video)
        println(s"[CONTROLLER] Store erfolgreich: id=$id")
        Ok(Json.obj("status" -> "success", "originalId" -> id))
      case None =>
        println(s"[CONTROLLER] Store: kein Video gefunden")
        BadRequest(Json.obj("status" -> "error", "message" -> "Keine Videodatei"))
    }
  }

  // Gespeichertes Original mit Settings verarbeiten
  def process: Action[MultipartFormData[TemporaryFile]] = Action.async(parse.multipartFormData) { request =>
    request.body.dataParts.get("originalId").flatMap(_.headOption) match {
      case Some(originalId) =>
        println(s"[CONTROLLER] Process mit originalId=$originalId")
        videoService.handleProcess(request.body, originalId).map {
          case Right(filename) =>
            println(s"[CONTROLLER] Process gestartet: $filename")
            Ok(Json.obj("status" -> "success", "filename" -> filename))
          case Left(error) =>
            println(s"[CONTROLLER] Process Fehler: $error")
            BadRequest(Json.obj("status" -> "error", "message" -> error))
        }
      case None =>
        println(s"[CONTROLLER] Process: keine originalId")
        Future.successful(BadRequest(Json.obj("status" -> "error", "message" -> "originalId fehlt")))
    }
  }

  // Legacy: Upload mit Datei
  def upload: Action[MultipartFormData[TemporaryFile]] = Action.async(parse.multipartFormData) { request =>
    request.body.file("video").map { video =>
      videoService.handleUpload(request.body, video).map {
        case Right(filename) =>
          println(s"[CONTROLLER] Upload erfolgreich: $filename")
          Ok(Json.obj("status" -> "success", "filename" -> filename))
        case Left(error) =>
          println(s"[CONTROLLER] Upload Fehler: $error")
          BadRequest(Json.obj("status" -> "error", "message" -> error))
      }
    }.getOrElse {
      println(s"[CONTROLLER] Upload: kein Video gefunden")
      Future.successful(BadRequest("Missing file"))
    }
  }

  def checkVideo(filename: String): Action[AnyContent] = Action {
    if (videoService.checkVideoExists(filename)) {
      videoService.getProcessedVideoFile(filename) match {
        case Some(file) =>
          println(s"[CHECK] Ready: $filename  size=${file.length()} bytes")
          Ok(Json.obj("exists" -> true, "size" -> file.length()))
        case None =>
          println(s"[CHECK] Status Ready aber Datei fehlt: $filename")
          Ok(Json.obj("exists" -> false))
      }
    } else {
      Ok(Json.obj("exists" -> false))
    }
  }

  def download(filename: String): Action[AnyContent] = Action {
    videoService.getProcessedVideoFile(filename) match {
      case Some(file) =>
        println(s"[DOWNLOAD] $filename  size=${file.length()} bytes")
        Ok.sendFile(file, inline = false)
      case None =>
        println(s"[DOWNLOAD] Nicht gefunden: $filename")
        NotFound("File not found.")
    }
  }
}
