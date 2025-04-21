package video

import play.api.libs.json._

case class UploadResult(
  status: String,
  filename: String,
  startTime: Long,
  endTime: Long,
  volume: Double,
  message: String,
  processedVideo: String
)

object UploadResult {
  implicit val format: OFormat[UploadResult] = Json.format[UploadResult]
}
