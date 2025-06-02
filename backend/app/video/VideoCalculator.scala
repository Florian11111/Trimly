package video

import java.io.File
import scala.util.{Try, Random}

object VideoCalculator {

  case class ProcessingParams(
    startTimeMs: Long,
    endTimeMs: Long,
    volumeFactor: Double = 1.0,
    framerate: Option[Double] = None,
    bitrate: Option[Long] = None,
    width: Option[Int] = None,
    height: Option[Int] = None,
    maxSizeMb: Option[Double] = None
  )

  def process(
    inputFile: File,
    outputDir: File,
    params: ProcessingParams
  ): Either[String, File] = {

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
        params: ProcessingParams
    ): Either[String, File] = {
    }
}