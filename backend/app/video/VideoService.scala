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

sealed trait VideoStatus
object VideoStatus {
  case object Computing extends VideoStatus
  case object Ready extends VideoStatus
  case class Failed(message: String) extends VideoStatus
}
import VideoStatus._

@Singleton
class VideoService @Inject()(actorSystem: ActorSystem)(implicit ec: ExecutionContext) {

  private val tmpDir      = new File(System.getProperty("java.io.tmpdir"))
  private val processedDir = new File(tmpDir, "processed_videos")
  private val originalsDir = new File(tmpDir, "original_videos")

  private val videoStatusMap  = TrieMap.empty[String, VideoStatus]
  private val originalFileMap = TrieMap.empty[String, String] // originalId -> filepath
  private val originalLastUse = TrieMap.empty[String, Long]   // originalId -> letzte Nutzung (ms)

  if (!processedDir.exists()) processedDir.mkdirs()
  if (!originalsDir.exists()) originalsDir.mkdirs()

  println(s"[INIT] processedDir: ${processedDir.getAbsolutePath}")
  println(s"[INIT] originalsDir: ${originalsDir.getAbsolutePath}")

  // GPU-Erkennung + CUDA-Aufwärmen im Hintergrund, damit der erste Job nicht wartet
  Future(FFmpegUtils.gpuAvailable)

  // ─── Original speichern, 1 Stunde behalten ───────────────────────────────

  def storeOriginal(video: MultipartFormData.FilePart[TemporaryFile]): String = {
    val id       = Random.alphanumeric.take(16).mkString
    val filename = s"orig_${id}.mp4"
    val dest     = new File(originalsDir, filename)
    video.ref.moveTo(dest, replace = true)
    originalFileMap.put(id, dest.getAbsolutePath)
    originalLastUse.put(id, System.currentTimeMillis())
    println(s"[STORE] Original gespeichert: $filename  id=$id  size=${dest.length()} bytes")
    scheduleOriginalCleanup(id, dest)
    id
  }

  // Originale 1 Stunde nach der letzten Nutzung löschen (Editor-Sitzungen können länger dauern)
  private val OriginalRetention = 1.hour

  private def scheduleOriginalCleanup(id: String, dest: File): Unit = {
    actorSystem.scheduler.scheduleOnce(OriginalRetention) {
      val idleMs = System.currentTimeMillis() - originalLastUse.getOrElse(id, 0L)
      if (idleMs < OriginalRetention.toMillis) {
        scheduleOriginalCleanup(id, dest)
      } else {
        originalFileMap.remove(id)
        originalLastUse.remove(id)
        if (dest.exists()) {
          dest.delete()
          println(s"[STORE] Original gelöscht nach 1 Stunde ohne Nutzung: ${dest.getName}")
        }
      }
    }
  }

  // Pfad zu einem gespeicherten Original; zählt als Nutzung
  def originalPath(id: String): Option[String] =
    originalFileMap.get(id).filter(p => new File(p).exists()).map { p =>
      originalLastUse.put(id, System.currentTimeMillis())
      p
    }

  // ─── Mit originalId verarbeiten ──────────────────────────────────────────

  // Left(None) = Original nicht (mehr) vorhanden, Left(Some(fehler)) = sonstiger Fehler
  def handleProcess(data: MultipartFormData[TemporaryFile], originalId: String): Future[Either[Option[String], String]] = {
    println(s"[PROCESS] Anfrage mit originalId=$originalId")
    originalPath(originalId) match {
      case None =>
        println(s"[PROCESS] Original nicht gefunden für id=$originalId")
        Future.successful(Left(None))
      case Some(path) =>
        println(s"[PROCESS] Verarbeite Original: $path  size=${new File(path).length()} bytes")
        processFile(data, path, originalId).map(_.left.map(Some(_)))
    }
  }

  // ─── Kern-Verarbeitung (gemeinsam für store+process und legacy upload) ───

  private def processFile(data: MultipartFormData[TemporaryFile], inputPath: String, baseName: String): Future[Either[String, String]] = {
    val startTime = data.dataParts.get("startTime").flatMap(_.headOption).flatMap(s => Try(s.toInt).toOption)
    val endTime   = data.dataParts.get("endTime").flatMap(_.headOption).flatMap(s => Try(s.toInt).toOption)
    val volume    = data.dataParts.get("volume").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption).getOrElse(1.0)
    val maxSizeMb = data.dataParts.get("maxSizeMb").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption).filter(_ > 0)
    val framerate = data.dataParts.get("framerate").flatMap(_.headOption).flatMap(s => Try(s.toDouble).toOption)
    val width: Option[Int] = data.dataParts.get("resolution").flatMap(_.headOption).flatMap { s =>
      val parts = s.split("x"); if (parts.length == 2) Try(parts(0).toInt).toOption else None
    }
    val height: Option[Int] = data.dataParts.get("resolution").flatMap(_.headOption).flatMap { s =>
      val parts = s.split("x"); if (parts.length == 2) Try(parts(1).toInt).toOption else None
    }
    val bitrate = data.dataParts.get("bitrate").flatMap(_.headOption).flatMap(s => Try(s.toLong).toOption)
    // mode=original: nur schneiden, Auflösung/Bitrate/Größenlimit werden ignoriert
    val trimOnly = data.dataParts.get("mode").flatMap(_.headOption).contains("original")
    // output: "both" (Standard), "video" (ohne Ton) oder "audio" (nur Ton als MP3)
    val output = data.dataParts.get("output").flatMap(_.headOption).getOrElse("both")
    val audioOnly = output == "audio"
    val removeAudio = output == "video" || data.dataParts.get("removeAudio").flatMap(_.headOption).contains("true")

    val suffix       = Random.alphanumeric.take(8).mkString
    val outFilename  = s"${baseName}_${suffix}_r.${if (audioOnly) "mp3" else "mp4"}"
    val outPath      = new File(processedDir, outFilename).getAbsolutePath

    println(s"[PROCESS] Settings: start=$startTime end=$endTime vol=$volume fps=$framerate bitrate=$bitrate res=${width}x${height} maxSize=$maxSizeMb trimOnly=$trimOnly output=$output")
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
      volume        = Some(volume),
      maxSizeMb     = if (trimOnly) None else maxSizeMb,
      trimOnly      = trimOnly,
      removeAudio   = removeAudio,
      audioOnly     = audioOnly
    )

    runJob(outFilename, outPath) {
      scala.concurrent.Await.result(VideoCalculator.process(conv), Duration.Inf)
    }
    Future.successful(Right(outFilename))
  }

  // Startet die Verarbeitung im Hintergrund; Status über /check abfragbar
  private def runJob(outFilename: String, outPath: String, cleanup: () => Unit = () => ())(work: => Either[String, String]): Unit = {
    videoStatusMap.put(outFilename, Computing)
    println(s"[PROCESS] Status Computing gesetzt für $outFilename")

    new Thread(() => {
      try {
        println(s"[FFMPEG] Starte Verarbeitung für $outFilename ...")
        val result = work
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
            markFailed(outFilename, outPath, error)
        }
      } catch {
        case ex: Throwable =>
          println(s"[FFMPEG] Exception bei $outFilename: ${ex.getMessage}")
          markFailed(outFilename, outPath, s"Interner Fehler: ${ex.getMessage}")
      } finally {
        cleanup()
      }
    }).start()
  }

  // Fehler merken, damit /check ihn melden kann; halbfertige Ausgabe löschen
  private def markFailed(outFilename: String, outPath: String, error: String): Unit = {
    videoStatusMap.update(outFilename, Failed(error))
    new File(outPath).delete()
    actorSystem.scheduler.scheduleOnce(10.minutes) {
      videoStatusMap.remove(outFilename)
    }
  }

  // ─── Editor: Projekt rendern ─────────────────────────────────────────────

  // Left((fehler, fehlende originalIds)) bei Fehler
  def handleRender(data: MultipartFormData[TemporaryFile]): Either[(String, Seq[String]), String] = {
    val projectJson = data.dataParts.get("project").flatMap(_.headOption)
      .getOrElse(return Left(("Projektdaten fehlen.", Nil)))
    val project = Try(play.api.libs.json.Json.parse(projectJson).as[EditProject](EditProject.projectReads))
      .getOrElse(return Left(("Projektdaten sind ungültig.", Nil)))

    val ids = (project.video.map(_.originalId) ++ project.audio.map(_.originalId)).distinct
    val paths = ids.flatMap(id => originalPath(id).map(id -> _)).toMap
    val missing = ids.filterNot(paths.contains)
    if (missing.nonEmpty) return Left(("Ein Clip ist nicht mehr auf dem Server. Bitte Video erneut hinzufügen.", missing))

    val suffix = Random.alphanumeric.take(8).mkString
    val outFilename = s"edit_${suffix}_r.${if (project.output == "audio") "mp3" else "mp4"}"
    val outPath = new File(processedDir, outFilename).getAbsolutePath

    // Overlay-PNGs aus dem Upload in ein eigenes Verzeichnis für diesen Job
    val overlayDir = new File(processedDir, s"overlays_$suffix")
    overlayDir.mkdirs()
    val overlayFiles = data.files.filter(_.key.startsWith("overlay_")).map { part =>
      val dest = new File(overlayDir, s"${part.key.replaceAll("[^A-Za-z0-9_]", "")}.png")
      part.ref.moveTo(dest, replace = true)
      part.key -> dest.getAbsolutePath
    }.toMap

    EditRenderer.validate(project, overlayFiles) match {
      case Some(error) =>
        deleteRecursively(overlayDir)
        Left((error, Nil))
      case None =>
        println(s"[EDIT] Render: ${project.video.size} Video-, ${project.audio.size} Ton-Abschnitte, " +
          s"${project.zooms.size} Zooms, ${project.overlays.size} Overlays, output=${project.output} -> $outFilename")
        runJob(outFilename, outPath, cleanup = () => deleteRecursively(overlayDir)) {
          EditRenderer.render(project, paths, overlayFiles, outPath)
        }
        Right(outFilename)
    }
  }

  // Hält die Originale aktiv, solange der Editor offen ist
  def keepAlive(ids: Seq[String]): Unit = ids.foreach(originalPath)

  private def deleteRecursively(dir: File): Unit = {
    Option(dir.listFiles()).foreach(_.foreach(_.delete()))
    dir.delete()
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

  def getStatus(filename: String): Option[VideoStatus] =
    videoStatusMap.get(filename)

  // Nur bekannte, fertige Jobs ausliefern (verhindert z.B. "../" im Dateinamen)
  def getProcessedVideoFile(filename: String): Option[File] = {
    val f = new File(processedDir, filename)
    if (checkVideoExists(filename) && f.isFile) Some(f) else None
  }
}
