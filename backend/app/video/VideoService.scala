package video

import play.api.libs.Files.TemporaryFile
import play.api.mvc.MultipartFormData
import scala.concurrent.{ExecutionContext, Future}
import java.io.File
import scala.util.{Random, Try}
import javax.inject._
import scala.concurrent.duration._
import org.apache.pekko.actor.ActorSystem

import video.VideoConversion

import scala.collection.concurrent.TrieMap

object VideoStatus extends Enumeration {
  type VideoStatus = Value
  val Computing, Ready = Value
}
import VideoStatus._

@Singleton
class VideoService @Inject()(actorSystem: ActorSystem)(implicit ec: ExecutionContext) {

  private val tmpDir      = new File(System.getProperty("java.io.tmpdir"))
  private val processedDir = new File(tmpDir, "processed_videos")
  private val originalsDir = new File(tmpDir, "original_videos")

  private val videoStatusMap  = TrieMap.empty[String, VideoStatus]
  private val originalFileMap = TrieMap.empty[String, String] // originalId -> filepath

  if (!processedDir.exists()) processedDir.mkdirs()
  if (!originalsDir.exists()) originalsDir.mkdirs()

  println(s"[INIT] processedDir: ${processedDir.getAbsolutePath}")
  println(s"[INIT] originalsDir: ${originalsDir.getAbsolutePath}")

  // ─── Original speichern, 1 Stunde behalten ───────────────────────────────

  def storeOriginal(video: MultipartFormData.FilePart[TemporaryFile]): String = {
    val id       = Random.alphanumeric.take(16).mkString
    val filename = s"orig_${id}.mp4"
    val dest     = new File(originalsDir, filename)
    video.ref.moveTo(dest, replace = true)
    originalFileMap.put(id, dest.getAbsolutePath)
    println(s"[STORE] Original gespeichert: $filename  id=$id  size=${dest.length()} bytes")

    actorSystem.scheduler.scheduleOnce(1.hour) {
      originalFileMap.remove(id)
      if (dest.exists()) {
        dest.delete()
        println(s"[STORE] Original gelöscht nach 1 Stunde: $filename")
      }
    }
    id
  }

  // ─── Mit originalId verarbeiten ──────────────────────────────────────────

  def handleProcess(data: MultipartFormData[TemporaryFile], originalId: String): Future[Either[String, String]] = {
    println(s"[PROCESS] Anfrage mit originalId=$originalId")
    originalFileMap.get(originalId) match {
      case None =>
        println(s"[PROCESS] Original nicht gefunden für id=$originalId")
        Future.successful(Left("Original video nicht gefunden. Bitte erneut hochladen."))
      case Some(path) =>
        val f = new File(path)
        if (!f.exists()) {
          println(s"[PROCESS] Original-Datei fehlt: $path")
          Future.successful(Left("Original-Datei fehlt. Bitte erneut hochladen."))
        } else {
          println(s"[PROCESS] Verarbeite Original: $path  size=${f.length()} bytes")
          processFile(data, path, originalId)
        }
    }
  }

  // ─── Kern-Verarbeitung (gemeinsam für store+process und legacy upload) ───

  private def processFile(data: MultipartFormData[TemporaryFile], inputPath: String, baseName: String): Future[Either[String, String]] = {
    val startTime = data.dataParts.get("startTime").flatMap(_.headOption).flatMap(s => Try(s.toInt).toOption)
    val endTime   = data.dataParts.get("endTime").flatMap(_.headOption).flatMap(s => Try(s.toInt).toOption)
    val volume    = data.dataParts.get("volume").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption).getOrElse(1.0)
    val maxSizeMb = data.dataParts.get("maxSizeMb").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption).getOrElse(-1.0)
    val framerate = data.dataParts.get("framerate").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption)
    val width: Option[Int] = data.dataParts.get("resolution").flatMap(_.headOption).flatMap { s =>
      val parts = s.split("x"); if (parts.length == 2) Try(parts(0).toInt).toOption else None
    }
    val height: Option[Int] = data.dataParts.get("resolution").flatMap(_.headOption).flatMap { s =>
      val parts = s.split("x"); if (parts.length == 2) Try(parts(1).toInt).toOption else None
    }
    val bitrate = data.dataParts.get("bitrate").flatMap(_.headOption).flatMap(s => Try(s.toLong).toOption)

    val suffix       = Random.alphanumeric.take(8).mkString
    val outFilename  = s"${baseName}_${suffix}_r.mp4"
    val outPath      = new File(processedDir, outFilename).getAbsolutePath

    println(s"[PROCESS] Settings: start=$startTime end=$endTime vol=$volume fps=$framerate bitrate=$bitrate res=${width}x${height} maxSize=$maxSizeMb")
    println(s"[PROCESS] Output: $outPath")

    val conv = VideoConversion(
      filePath      = inputPath,
      filePathReady = outPath,
      startTime     = startTime,
      endTime       = endTime,
      bitrate       = bitrate,
      framerate     = framerate,
      width         = width,
      height        = height,
      volume        = Some(volume)
    )

    videoStatusMap.put(outFilename, Computing)
    println(s"[PROCESS] Status Computing gesetzt für $outFilename")

    new Thread(() => {
      try {
        println(s"[FFMPEG] Starte Verarbeitung für $outFilename ...")
        val result = scala.concurrent.Await.result(VideoCalculator.process(conv), Duration.Inf)
        result match {
          case Right(_) =>
            val size = new File(outPath).length()
            println(s"[FFMPEG] Fertig: $outFilename  size=$size bytes")
            videoStatusMap.update(outFilename, Ready)
            // Ergebnis nach 30 Minuten löschen
            actorSystem.scheduler.scheduleOnce(30.minutes) {
              videoStatusMap.remove(outFilename)
              val f = new File(outPath)
              if (f.exists()) { f.delete(); println(s"[CLEANUP] Ergebnis gelöscht: $outFilename") }
            }
          case Left(error) =>
            println(s"[FFMPEG] Fehler bei $outFilename: $error")
            videoStatusMap.remove(outFilename)
        }
      } catch {
        case ex: Throwable =>
          println(s"[FFMPEG] Exception bei $outFilename: ${ex.getMessage}")
          videoStatusMap.remove(outFilename)
      }
    }).start()

    Future.successful(Right(outFilename))
  }

  // ─── Legacy: Upload mit Datei (Fallback falls kein Store verwendet) ──────

  def handleUpload(data: MultipartFormData[TemporaryFile], video: MultipartFormData.FilePart[TemporaryFile]): Future[Either[String, String]] = {
    println(s"[UPLOAD] Legacy upload: ${video.filename}  size=${video.ref.path.toFile.length()} bytes")
    val suffix = Random.alphanumeric.take(10).mkString
    val tmpFile = new File(processedDir, s"tmp_${suffix}.mp4")
    video.ref.moveTo(tmpFile, replace = true)
    processFile(data, tmpFile.getAbsolutePath, video.filename.stripSuffix(".mp4"))
  }

  // ─── Check / Download ────────────────────────────────────────────────────

  def checkVideoExists(filename: String): Boolean =
    videoStatusMap.get(filename).contains(Ready)

  def getProcessedVideoFile(filename: String): Option[File] = {
    val f = new File(processedDir, filename)
    if (f.exists()) Some(f) else None
  }
}
