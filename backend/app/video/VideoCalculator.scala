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

    val processedOpt: Option[File] =
      if (params.maxSizeMb.exists(_ > 0)) {
        VideoCalculatorWithSizeLimit(
          inputFile,
          outputDir,
          params,
          info
        ) match {
          case Right(file) => Some(file)
          case Left(_) => None
        }
      } else {
        FFmpegUtils.processVideo(
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
    // 1. Hole aktuelle Größe und Zielgröße
    val currentSizeBytes = infoOpt.get("size") match {
      case Some(s: Long) => s
      case Some(s: String) => Try(s.toLong).getOrElse(0L)
      case _ => return Left("Size not found in video info.")
    }
    val targetSizeBytes = params.maxSizeMb match {
      case Some(maxSizeMb) => (maxSizeMb * 1024 * 1024).toLong
      case None => return Left("No size limit set.")
    }
    if (targetSizeBytes < currentSizeBytes / 10)
      return Left(s"Target size too small: $targetSizeBytes bytes (<10% of original $currentSizeBytes bytes)")

    // 2. Berechne Ziel/Original-Multiplier
    val overallMultiplier = targetSizeBytes.toDouble / currentSizeBytes.toDouble

    // 3. Ermittle aktuelle Werte
    val origFramerate = infoOpt.get("framerate") match {
      case Some(f: Double) => f
      case Some(f: String) => Try(f.toDouble).getOrElse(0.0)
      case _ => return Left("Framerate not found in video info.")
    }
    val origWidth = infoOpt.get("width") match {
      case Some(w: Int) => w
      case Some(w: String) => Try(w.toInt).getOrElse(0)
      case _ => return Left("Width not found in video info.")
    }
    val origHeight = infoOpt.get("height") match {
      case Some(h: Int) => h
      case Some(h: String) => Try(h.toInt).getOrElse(0)
      case _ => return Left("Height not found in video info.")
    }
    val origBitrate = infoOpt.get("bitrate") match {
      case Some(b: Long) => b
      case Some(b: String) => Try(b.toLong).getOrElse(0L)
      case _ => return Left("Bitrate not found in video info.")
    }

    // 4. Verteile Reduktion gleichmäßig auf FPS, Auflösung, Bitrate
    //    (geometrisches Mittel, damit keine Komponente zu stark leidet)
    val factors = distributeReduction(overallMultiplier, origFramerate, origWidth, origHeight, origBitrate)

    val targetFramerate = math.max(30.0, math.min(origFramerate, factors.fps))
    val targetWidth = math.max(100, (origWidth * factors.res).toInt)
    val targetHeight = math.max(100, (origHeight * factors.res).toInt)
    val targetBitrate = math.max(100_000, (origBitrate * factors.bitrate).toLong)

    // 5. Übergib an FFmpegUtils
    val processedOpt = FFmpegUtils.processVideo(
      videoPath = inputFile.getAbsolutePath,
      startTimeMs = params.startTimeMs,
      endTimeMs = params.endTimeMs,
      volumeFactor = params.volumeFactor,
      outputDir = outputDir,
      framerate = Some(targetFramerate),
      bitrate = Some(targetBitrate),
      width = Some(targetWidth),
      height = Some(targetHeight)
    )

    processedOpt match {
      case Some(file) =>
        val sizeMb = file.length() / (1024.0 * 1024.0)
        if (sizeMb > params.maxSizeMb.getOrElse(Double.MaxValue)) {
          file.delete()
          Left(f"Output file is too large (${sizeMb}%.2f MB > ${params.maxSizeMb.get} MB).")
        } else {
          Right(file)
        }
      case None => Left("FFmpeg processing failed.")
    }
  }

  // Hilfsfunktion: verteilt Reduktion gleichmäßig auf FPS, Auflösung, Bitrate
  case class ReductionFactors(fps: Double, res: Double, bitrate: Double)
  
  def distributeReduction(
    overallMultiplier: Double,
    origFramerate: Double,
    origWidth: Int,
    origHeight: Int,
    origBitrate: Long
  ): ReductionFactors = {
    // FPS darf nicht unter 30 (außer Original ist schon weniger)
    val minFps = math.min(30.0, origFramerate)
    val fpsFactor = minFps / origFramerate

    // Restliche Reduktion auf Auflösung und Bitrate verteilen
    // (geometrisches Mittel für gleichmäßige Qualität)
    val remainingMultiplier = overallMultiplier / fpsFactor
    val resAndBitrateFactor = math.sqrt(remainingMultiplier)
    ReductionFactors(
      fps = fpsFactor,
      res = resAndBitrateFactor,
      bitrate = resAndBitrateFactor
    )
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
    val duration: Double = infoOpt.get("duration") match {
      case Some(d: Double) => d * 1000 // convert to ms
      case Some(d: String) => Try(d.toDouble * 1000).getOrElse(0.0) // convert to ms
      case _ => return Left("Duration not found in video info.")
    }
    if (duration <= 0) return Left("Invalid video duration.")

    val targetLengthMs = params.endTimeMs - params.startTimeMs
    if (targetLengthMs <= 0) return Left("Target length must be positive.")
    // add 10% buffer to the target length
    val ratio = targetLengthMs.toDouble / duration
    val bufferedRatio = if (ratio < 0.8) ratio * 1.1 else ratio
    Right(Math.min(bufferedRatio, 1.0))
  }

}