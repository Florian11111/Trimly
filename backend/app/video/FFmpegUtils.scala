package video

import java.io.File
import scala.sys.process._
import scala.util.Random
import java.nio.file.Paths

object FFmpegUtils {

  private val ffmpegPath = "C:\\Users\\flori\\Documents\\ffmpeg\\bin\\ffmpeg"
  private val ffprobePath = "C:\\Users\\flori\\Documents\\ffmpeg\\bin\\ffprobe"

  def getVideoDurationMs(videoPath: String): Option[Long] = {
    val ffprobeCommand = Seq(
      ffprobePath, "-v", "error",
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

  def processVideo(
    videoPath: String, 
    startTimeMs: Long, 
    endTimeMs: Long, 
    volumeFactor: Double, 
    outputDir: File, 
    width: Option[Int] = None,  
    height: Option[Int] = None, 
    threads: Int = 6 
    ): Option[File] = {

        println(s"Processing video: $videoPath")
        println(s"Start time: $startTimeMs ms, End time: $endTimeMs ms, Volume factor: $volumeFactor")
        println(s"Width: ${width.getOrElse("None")}, Height: ${height.getOrElse("None")}")

        val randomSuffix = Random.alphanumeric.take(8).mkString
        val filenameWithRandomSuffix = Paths.get(videoPath).getFileName.toString.replace(".mp4", s"_$randomSuffix.mp4")
        val outputFilePath = outputDir.toPath.resolve(filenameWithRandomSuffix).toString

        val startSeconds = startTimeMs / 1000.0
        val endSeconds = endTimeMs / 1000.0

        val resolutionFilter = (width, height) match {
  case (Some(w), Some(h)) => 
    println(s"Resolution Filter: scale=$w:$h") // Debug: Zeige den Filter
    Some(s"-vf scale=$w:$h") // Verwendet -vf statt -filter:v
  case _ => 
    println("No resolution filter applied.") // Debug: Keine Auflösung angegeben
    None
}

val ffmpegCommand = {
  val baseCommand = Seq(
    ffmpegPath,
    "-y",
    "-ss", startSeconds.toString,
    "-to", endSeconds.toString,
    "-i", videoPath,
    "-filter:a", s"volume=$volumeFactor"
  )
  
  // Wenn der Filter existiert, füge ihn der Basis-Command-Liste hinzu
  resolutionFilter match {
    case Some(filter) => baseCommand :+ filter
    case None => baseCommand
  }
} ++ Seq(
  "-c:v", "libx264",     // Software-codierung statt NVENC
  "-c:a", "aac",
  "-strict", "experimental",
  "-threads", threads.toString, 
  "-f", "mp4",            // Hier wird das Format explizit gesetzt
  outputFilePath
)


        println(s"FFmpeg Command: ${ffmpegCommand.mkString(" ")}") // Debug: FFmpeg-Befehl ausgeben


        val result = ffmpegCommand.!(ProcessLogger(
          out => println(s"FFmpeg Output: $out"),  // Debug: Zeige die Standardausgabe
          err => println(s"FFmpeg Error: $err")   // Debug: Zeige die Fehlermeldung
        ))

        // Debug: Ergebnis des Befehls
        println(s"FFmpeg exit code: $result")

        if (result == 0) {
          println(s"Video processed successfully. Output file: $outputFilePath")
          Some(new File(outputFilePath))
        } else {
          println(s"Error processing video. Exit code: $result")
          None
        }
    }


  def compressVideo(videoPath: String, minSize: Double, outputDir: File, maxAttempts: Int = 5): Option[File] = {
    val randomSuffix = Random.alphanumeric.take(8).mkString
    val filenameWithRandomSuffix = Paths.get(videoPath).getFileName.toString.replace(".mp4", s"_compressed_$randomSuffix.mp4")
    val outputFilePath = outputDir.toPath.resolve(filenameWithRandomSuffix).toString

    val durationMs = getVideoDurationMs(videoPath)

    durationMs match {
      case Some(duration) =>
        val durationSeconds = duration / 1000.0
        val targetSizeBytes = minSize * 1024 * 1024
        val targetBitrate = (targetSizeBytes * 8) / durationSeconds

        var attempts = 0
        var result: Option[File] = None

        while (attempts < maxAttempts && result.isEmpty) {
          val ffmpegCommand = Seq(
            ffmpegPath,
            "-y",
            "-i", videoPath,
            "-filter:v", "fps=30",             // Framerate begrenzen
            "-b:v", s"${targetBitrate.toInt}k",    // Zielbitrate
            "-preset", "fast",
            "-c:a", "aac",
            "-b:a", "128k",
            "-loglevel", "quiet",                  // <- Keine FFmpeg-Ausgabe
            outputFilePath
          )

          // Starte FFmpeg ohne Ausgabe
          val processResult = Process(ffmpegCommand).!(ProcessLogger(_ => (), _ => ()))

          // Datei-Größe prüfen (für Debugging)
          val outputFileSizeKb = new File(outputFilePath).length() / 1024.0
          println(f"Versuch $attempts: Datei ist $outputFileSizeKb%.2f KB groß (Ziel: ${minSize * 1024}%.2f KB)")

          if (processResult == 0 && outputFileSizeKb <= minSize * 1024) {
            result = Some(new File(outputFilePath))
          } else {
            attempts += 1
          }
        }

        result

      case None =>
        println("Fehler: Videodauer konnte nicht bestimmt werden.")
        None
    }
  }
}
