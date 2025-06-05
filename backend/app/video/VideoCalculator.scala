package video

import java.io.File
import scala.util.{Try, Random}
import video.VideoConversion
import video.FFmpegUtils
import video.FFmpegUtils.getVideoInfo
import video.VideoInfo
import scala.concurrent.{Future, ExecutionContext}


object VideoCalculator {

  def process(
    videoConversion: VideoConversion
  )(implicit ec: ExecutionContext): Future[Either[String, String]] = Future {
    val maybeInfo = FFmpegUtils.getVideoInfo(videoConversion.filePath)
    if (maybeInfo.isLeft) {
      Left(maybeInfo.swap.getOrElse("Unknown error"))
    } else {
      val info = maybeInfo.toOption.get

      val width = videoConversion.width.orElse(Some(info.width)).getOrElse(0)
      val height = videoConversion.height.orElse(Some(info.height)).getOrElse(0)
      val fps = videoConversion.framerate.orElse(Some(info.fps)).getOrElse(30.0)

      val normalBitrate: Long = {
        val base = (width, height) match {
          case (w, h) if w >= 3840 || h >= 2160 => 35000 // 4K
          case (w, h) if w >= 2560 || h >= 1440 => 16000 // 1440p
          case (w, h) if w >= 1920 || h >= 1080 => 8000  // 1080p
          case (w, h) if w >= 1280 || h >= 720  => 5000  // 720p
          case _ => 2500
        }
        if (fps > 30) (base * 1.3).toLong else base
      }

      val usedBitrate = videoConversion.bitrate
        .orElse(Some(info.streamBitRate.toLong))
        .filter(_ > 0)
        .map(b => Math.min(b, normalBitrate))
        .getOrElse(normalBitrate)      

      if (videoConversion.startTime.getOrElse(0) < 0)
        Left("Start time must be non-negative.")
      else if (videoConversion.endTime.getOrElse(0) <= videoConversion.startTime.getOrElse(0))
        Left("End time must be after start time.")
      else if (videoConversion.endTime.getOrElse(0) > (info.duration * 1000).toInt)
        Left(s"End time exceeds video duration: ${info.duration} ms.")
      else {
        val adjustedConversion = videoConversion.copy(
          startTime = Some(videoConversion.startTime.getOrElse(0)),
          endTime = Some(videoConversion.endTime.getOrElse(info.duration.toInt * 1000)),
          bitrate = Some(usedBitrate),
          framerate = Some(fps),
          width = Some(width),
          height = Some(height),
          volume = videoConversion.volume.orElse(Some(1.0))
        )

        FFmpegUtils.processVideo(adjustedConversion) match {
          case Left(error) => Left(error)
          case Right(msg)  => Right("Processed successfully")
        }
      }
    }
  }
}

/*
  def videoConversionWithSizeLimit(
      inputFile: File,
      outputDir: File,
      params: ProcessingParams,
      infoOpt: Map[String, Any]
  ): Either[String, File] = {

    val currentSizeBytes = infoOpt.get("size") match {
      case Some(s: Long) => s
      case Some(s: String) => Try(s.toLong).getOrElse(0L)
      case _ => Left("Size not found in video info.")
    }
    val targetSize = params.maxSizeMb match {
      case Some(maxSizeMb) => maxSizeMb * 1024 * 1024 // convert MB to bytes
      case None => return Left("No size limit set.")
    }
    // test if the target size is less then 1/10 of the current size
    if (targetSize < currentSizeBytes /10) {
      return Left(s"Current Target size is too small: ${currentSizeBytes} bytes (less 10% of original).")
    } 
    
    // video lenght ----------------------------

    // calculate the target length in ms
    val lengthMultiplier = calculatLenghtMultiplier(inputFile, outputDir, params, infoOpt)
    lengthMultiplier match {
      case Left(error) => return Left(error)
      case Right(multiplier) => currentMultiplier = multiplier
    }
    // add lenght multiplier to currentSizeBytes + buffer 10% 
    val targetSizeShorten = (currentSizeBytes * currentMultiplier * 1.1).toLong
    // fps -------------------------------
    var targetFramerate = calculateFPSMultiplier(inputFile, outputDir, params, infoOpt)
    targetFramerate match {
      case Left(error) => return Left(error)
      case Right((multiplier, framerate)) => 
        val targetSizeWithFPS = (targetSizeShorten * multiplier * 1.1).toLong
        val targetFramerate = framerate
        if (framerate > 30) {
          targetFramerate = 30
        }
    }
    var size = targetSizeWithFPS
    var bitrate = params.bitrate match {
      case Some(b) => b
      case None => Left("Bitrate not set.")
    }
    var width = params.width match {
      case Some(w) => w
      case None => Left("Width not set.")
    }
    var height = params.height match {
      case Some(h) => h
      case None => Left("Height not set.")
    }
    // while loop while the target size is not reached. in it reduce bitrate, width and height
    while (currentSizeBytes > targetSizeShorten) {
      // reduce bitrate by 10%
      params.bitrate match {
        case Some(bitrate) if bitrate > 1000 => 
          params.bitrate = Some((bitrate * 0.9).toLong)
        case _ => 
          return Left("Bitrate is too low or not set.")
      }
      // reduce width and height by 10%
      params.width match {
        case Some(width) if width > 100 => 
          params.width = Some((width * 0.9).toInt)
        case _ => 
          return Left("Width is too low or not set.")
      }
      params.height match {
        case Some(height) if height > 100 => 
          params.height = Some((height * 0.9).toInt)
        case _ => 
          return Left("Height is too low or not set.")
      }
    }
  }


  def calculateFPSMultiplier(
    inputFile: File,
    outputDir: File,
    params: ProcessingParams,
    infoOpt: Map[String, Any]
  ): Either[String, (Double, Double)] = {
    val framerate = infoOpt.get("framerate") match {
      case Some(f: Double) => f
      case Some(f: String) => Try(f.toDouble).getOrElse(0.0)
      case _ => return Left("Framerate not found in video info.")
    }

    if (framerate <= 0) return Left("Invalid framerate.")

    // Wenn Original-FPS > 30 → Ziel ist 30, aber nur halber Einfluss (realistischer)
    if (framerate > 30) {
      val theoreticalReduction = 30.0 / framerate
      val effectiveMultiplier = 1.0 - ((1.0 - theoreticalReduction) * 0.5) // nur halber Effekt
      return Right((effectiveMultiplier, 30.0))
    }

    // Wenn Ziel-FPS schon gesetzt ist
    params.framerate match {
      case Some(targetFps) if targetFps < framerate =>
        val theoreticalReduction = targetFps / framerate
        val effectiveMultiplier = 1.0 - ((1.0 - theoreticalReduction) * 0.5)
        Right((effectiveMultiplier, targetFps))
      case _ =>
        Right((1.0, framerate)) 
    }
  }


  def calculatLenghtMultiplier(
    inputFile: File,
    outputDir: File,
    params: ProcessingParams,
    infoOpt: Map[String, Any]
  ): Either[String, Double] = {
    // get duration from infoOpt
    val duration = infoOpt.get("duration") match {
      case Some(d: Double) => d * 1000 // convert to ms
      case Some(d: String) => Try(d.toDouble * 1000).getOrElse(0.0) // convert to ms
      case _ => Left("Duration not found in video info.")
    }
    if (duration <= 0) return Left("Invalid video duration.")

    val targetLengthMs = params.endTimeMs - params.startTimeMs
    if (targetLengthMs <= 0) return Left("Target length must be positive.")
    // add 10% buffer to the target length
    val ratio = targetLengthMs / duration
    val bufferedRatio = if (ratio < 0.8) ratio * 1.1 else ratio
    Right(Math.min(bufferedRatio, 1.0))


  }
*/
