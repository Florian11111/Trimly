package video

case class VideoConversion(
    filePath: String,
    filePathReady: String,
    startTime: Option[Int],
    endTime: Option[Int],
    bitrate: Option[Long],
    framerate: Option[Double],
    width: Option[Int],
    height: Option[Int],
    volume: Option[Double],
    maxSizeMb: Option[Double] = None,
    trimOnly: Boolean = false, // trim only, don't re-encode
    removeAudio: Boolean = false, // output without audio track
    audioOnly: Boolean = false, // audio track only, as MP3
)

case class VideoInfo(
    duration: Double, // in seconds
    bitRate: Long, // in bits per second
    size: Long, // in bytes
    width: Int,
    height: Int,
    fps: Double, // frames per second
    streamBitRate: Int // stream bit rate in bits per second
)
