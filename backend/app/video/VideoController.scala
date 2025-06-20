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

  def upload: Action[MultipartFormData[TemporaryFile]] = Action.async(parse.multipartFormData) { request =>
    request.body.file("video").map { video =>
      videoService.handleUpload(request.body, video).map {
        case Right(filename) =>
          println(s"[DEBUG] Sending success response for uploaded file: $filename")
          Ok(Json.obj("status" -> "success", "filename" -> filename))

        case Left(error) =>
          println(s"[DEBUG] Sending error response: $error")
          BadRequest(Json.obj("status" -> "error", "message" -> error))
      }
    }.getOrElse {
      println(s"[DEBUG] No video file found in upload request.")
      Future.successful(BadRequest("Missing file"))
    }
  }


  // call videoService checkVideoExists (true or false)
  def checkVideo(filename: String): Action[AnyContent] = Action {
    if (videoService.checkVideoExists(filename))
      Ok(Json.obj("exists" -> true))
    else
      NotFound(Json.obj("exists" -> false, "message" -> "Video not found."))
  }

  def download(filename: String): Action[AnyContent] = Action {
    videoService.getProcessedVideoFile(filename) match {
      case Some(file) => Ok.sendFile(file, inline = false)
      case None       => NotFound("File not found.")
    }
  }
}
