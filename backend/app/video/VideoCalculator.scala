package video

import java.io.File
import scala.util.{Try, Random}

object VideoCalculator {

  
  case class VideoConversion(
    filePath: String,
    filePathReady: String,
    startTime: Int,
    endTime: Int,
    bitrate: Option[Long],
    framerate: Option[Double],
    width: Option[Int],
    height: Option[Int],
    volume: Option[Double],
  )
  def process(
    VideoCalculator: VideoConversion
  ): Future[Either[String, File]] = {

    if (!inputFile.exists())
      return Left(s"Input file does not exist: ${inputFile.getAbsolutePath}")

    val infoOpt = FFmpegUtils.getVideoInfo(inputFile.getAbsolutePath)
    if (infoOpt.isEmpty)
      return Left("Could not extract video metadata.")

    val info = infoOpt.get
    val duration = Try(info("duration").asInstanceOf[Double]).getOrElse(0.0) * 1000  // in ms

    if (params.startTimeMs < 0)
      return Left("Start time must be non-negative.")
    if (params.endTimeMs <= params.startTimeMs)
      return Left("End time must be after start time.")
    if (params.endTimeMs > duration)
      return Left(s"End time exceeds video duration: ${duration.toLong} ms.")

    // if no size limit is set, we can skip the size check
    if (params.maxSizeMb > 0) {
        VideoCalculatorWithSizeLimit(
            inputFile,
            outputDir,
            params,
            infoOpt
        )
    } else {
        val processedOpt = FFmpegUtils.processVideo(
        videoPath = inputFile.getAbsolutePath,
        startTimeMs = params.startTimeMs,
        endTimeMs = params.endTimeMs,
        volumeFactor = params.volumeFactor,
        outputDir = outputDir,
        framerate = params.framerate,
        bitrate = params.bitrate,
        width = params.width,
        height = params.height
        )
    }

    processedOpt match {
      case Some(file) =>
        val sizeMb = file.length() / (1024.0 * 1024.0)
        params.maxSizeMb match {
          case Some(maxMb) if sizeMb > maxMb =>
            file.delete()
            Left(f"Output file is too large (${sizeMb}%.2f MB > ${maxMb} MB).")
          case _ =>
            Right(file)
        }
      case None => Left("FFmpeg processing failed.")
    }
  }


  def VideoCalculatorWithSizeLimit(
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

}