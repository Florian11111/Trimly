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

  // Store the original, return its ID
  def store: Action[MultipartFormData[TemporaryFile]] = Action(parse.multipartFormData) { request =>
    request.body.file("video") match {
      case Some(video) =>
        val id = videoService.storeOriginal(video)
        println(s"[CONTROLLER] Store erfolgreich: id=$id")
        Ok(Json.obj("status" -> "success", "originalId" -> id))
      case None =>
        println(s"[CONTROLLER] Store: no video found")
        BadRequest(Json.obj("status" -> "error", "message" -> "No video file"))
    }
  }

  // Process a stored original with the given settings
  def process: Action[MultipartFormData[TemporaryFile]] = Action.async(parse.multipartFormData) { request =>
    request.body.dataParts.get("originalId").flatMap(_.headOption) match {
      case Some(originalId) =>
        println(s"[CONTROLLER] Process with originalId=$originalId")
        videoService.handleProcess(request.body, originalId).map {
          case Right(filename) =>
            println(s"[CONTROLLER] Process gestartet: $filename")
            Ok(Json.obj("status" -> "success", "filename" -> filename))
          case Left(None) =>
            // The frontend then uploads the original again automatically
            NotFound(Json.obj("status" -> "missing", "message" -> "Original video not found. Please upload it again."))
          case Left(Some(error)) =>
            println(s"[CONTROLLER] Process error: $error")
            BadRequest(Json.obj("status" -> "error", "message" -> error))
        }
      case None =>
        println(s"[CONTROLLER] Process: no originalId")
        Future.successful(BadRequest(Json.obj("status" -> "error", "message" -> "originalId is missing")))
    }
  }

  // Render an editor project (project JSON + overlay PNGs)
  def renderEdit: Action[MultipartFormData[TemporaryFile]] = Action(parse.multipartFormData) { request =>
    videoService.handleRender(request.body) match {
      case Right(filename) =>
        println(s"[CONTROLLER] Render gestartet: $filename")
        Ok(Json.obj("status" -> "success", "filename" -> filename))
      case Left((error, missing)) =>
        println(s"[CONTROLLER] Render error: $error")
        BadRequest(Json.obj("status" -> "error", "message" -> error, "missing" -> missing))
    }
  }

  // Editor is open: keep the originals from expiring
  def keepAlive: Action[JsValue] = Action(parse.json) { request =>
    videoService.keepAlive((request.body \ "ids").asOpt[Seq[String]].getOrElse(Seq.empty))
    Ok(Json.obj("status" -> "success"))
  }

  def checkVideo(filename: String): Action[AnyContent] = Action {
    videoService.getStatus(filename) match {
      case Some(VideoStatus.Ready) =>
        videoService.getProcessedVideoFile(filename) match {
          case Some(file) =>
            println(s"[CHECK] Ready: $filename  size=${file.length()} bytes")
            Ok(Json.obj("exists" -> true, "status" -> "ready", "size" -> file.length()))
          case None =>
            println(s"[CHECK] Status ready but file is missing: $filename")
            Ok(Json.obj("exists" -> false, "status" -> "error", "message" -> "Output file is missing"))
        }
      case Some(VideoStatus.Failed(error)) =>
        Ok(Json.obj("exists" -> false, "status" -> "error", "message" -> error))
      case Some(VideoStatus.Computing) =>
        Ok(Json.obj("exists" -> false, "status" -> "computing"))
      case None =>
        Ok(Json.obj("exists" -> false, "status" -> "unknown"))
    }
  }

  def download(filename: String, name: Option[String]): Action[AnyContent] = Action {
    videoService.getProcessedVideoFile(filename) match {
      case Some(file) =>
        println(s"[DOWNLOAD] $filename  size=${file.length()} bytes")
        // File name for the browser, without path components
        val downloadName = name.map(_.replaceAll("""[\\/]""", "_")).filter(_.nonEmpty).getOrElse(filename)
        Ok.sendFile(file, inline = false, fileName = _ => Some(downloadName))
      case None =>
        println(s"[DOWNLOAD] Not found: $filename")
        NotFound("File not found.")
    }
  }
}
