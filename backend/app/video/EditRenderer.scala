package video

import play.api.libs.json._
import java.io.File
import scala.sys.process._
import scala.util.Try

// Projektbeschreibung aus dem Editor-Tab. Alle Zeiten in Sekunden,
// Positionen relativ zum Ausgabebild (0..1).
case class EditPreset(width: Int, height: Int, fps: Double, bitrate: Long)
// Videospur: Abschnitte werden nacheinander abgespielt
case class EditVideoSeg(originalId: String, start: Double, end: Double)
// Tonspur: Abschnitte liegen frei auf der Timeline (at = Startzeit in der Ausgabe)
case class EditAudioSeg(originalId: String, start: Double, end: Double, at: Double, volume: Double)
// Zoom auf den Bereich x,y (oben links) mit Breite w; Höhe ergibt sich aus dem Seitenverhältnis
case class EditZoom(start: Double, end: Double, x: Double, y: Double, w: Double)
// Overlay = transparentes PNG in Ausgabegröße (Pfeile, Text, Bilder rendert der Browser)
case class EditOverlay(file: String, start: Double, end: Double)
case class EditProject(
  preset: EditPreset,
  video: Seq[EditVideoSeg],
  audio: Seq[EditAudioSeg],
  zooms: Seq[EditZoom],
  overlays: Seq[EditOverlay],
  output: String = "both" // "both", "video" (ohne Ton) oder "audio" (nur Ton als MP3)
)

object EditProject {
  implicit val presetReads: Reads[EditPreset] = Json.reads[EditPreset]
  implicit val videoReads: Reads[EditVideoSeg] = Json.reads[EditVideoSeg]
  implicit val audioReads: Reads[EditAudioSeg] = Json.reads[EditAudioSeg]
  implicit val zoomReads: Reads[EditZoom] = Json.reads[EditZoom]
  implicit val overlayReads: Reads[EditOverlay] = Json.reads[EditOverlay]
  implicit val projectReads: Reads[EditProject] = Json.using[Json.WithDefaultValues].reads[EditProject]
}

object EditRenderer {

  // Dauer des weichen Ein-/Auszoomens in Sekunden
  private val ZoomRamp = 0.3

  // Zahlen ohne wissenschaftliche Notation und unabhängig von der Locale
  private def num(d: Double): String =
    BigDecimal(d).setScale(4, BigDecimal.RoundingMode.HALF_UP).bigDecimal.stripTrailingZeros.toPlainString

  def validate(p: EditProject, overlayFiles: Map[String, String]): Option[String] = {
    val total = p.video.map(s => s.end - s.start).sum
    if (p.video.isEmpty) Some("Die Videospur ist leer.")
    else if (p.video.exists(s => s.start < 0 || s.end - s.start < 0.005)) Some("Ungültiger Video-Abschnitt.")
    else if (p.audio.exists(s => s.start < 0 || s.end - s.start < 0.005 || s.at < 0 || s.volume < 0))
      Some("Ungültiger Ton-Abschnitt.")
    else if (p.zooms.exists(z => z.end <= z.start || z.w <= 0 || z.w > 1 || z.x < 0 || z.y < 0 || z.x + z.w > 1.001 || z.y + z.w > 1.001))
      Some("Ungültiger Zoom-Bereich.")
    else if (p.overlays.exists(o => o.end <= o.start || !overlayFiles.contains(o.file)))
      Some("Ungültiges Overlay.")
    else if (p.preset.width < 16 || p.preset.height < 16 || p.preset.fps <= 0 || p.preset.bitrate <= 0)
      Some("Ungültige Export-Einstellungen.")
    else if (total > 6 * 3600) Some("Projekt ist zu lang.")
    else if (!Set("both", "video", "audio").contains(p.output)) Some("Ungültiges Ausgabeformat.")
    else None
  }

  /** Baut das ffmpeg-Kommando. paths: originalId -> Datei, overlayFiles: Overlay-Name -> PNG. */
  def buildCommand(
    p: EditProject,
    paths: Map[String, String],
    overlayFiles: Map[String, String],
    sourceFps: Double,
    audioAvailable: String => Boolean,
    outPath: String,
    useGpu: Boolean
  ): Seq[String] = {
    val W = p.preset.width - p.preset.width % 2
    val H = p.preset.height - p.preset.height % 2
    // Nicht mehr FPS als die schnellste Quelle, sonst nur duplizierte Frames
    val fps = if (sourceFps > 0) Math.min(p.preset.fps, sourceFps) else p.preset.fps
    val total = p.video.map(s => s.end - s.start).sum

    val inputs = Seq.newBuilder[String]
    val filters = Seq.newBuilder[String]
    var inputIndex = 0
    def addInput(args: String*): Int = { inputs ++= args; inputIndex += 1; inputIndex - 1 }

    // Videospur: jeder Abschnitt einzeln (schnelles Suchen per -ss vor -i), auf Ausgabegröße bringen, aneinanderhängen
    val videoLabels = p.video.zipWithIndex.map { case (seg, i) =>
      val idx = addInput("-ss", num(seg.start), "-t", num(seg.end - seg.start), "-i", paths(seg.originalId))
      filters += s"[$idx:v:0]scale=$W:$H:force_original_aspect_ratio=decrease," +
        s"pad=$W:$H:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${num(fps)},format=yuv420p,setpts=PTS-STARTPTS[v$i]"
      s"[v$i]"
    }
    filters += s"${videoLabels.mkString}concat=n=${videoLabels.size}:v=1:a=0[vcat]"
    var current = "[vcat]"

    // Zoom: Zoomfaktor und Bildmitte als Funktion der Zeit, mit weicher Rampe
    if (p.zooms.nonEmpty) {
      val ramps = p.zooms.map { z =>
        val r = num(Math.min(ZoomRamp, (z.end - z.start) / 2))
        s"clip((it-${num(z.start)})/$r,0,1)*clip((${num(z.end)}-it)/$r,0,1)"
      }
      val zoomExpr = "1" + p.zooms.zip(ramps).map { case (z, r) => s"+${num(1 / z.w - 1)}*$r" }.mkString
      val cxExpr = "0.5" + p.zooms.zip(ramps).map { case (z, r) => s"+${num(z.x + z.w / 2 - 0.5)}*$r" }.mkString
      val cyExpr = "0.5" + p.zooms.zip(ramps).map { case (z, r) => s"+${num(z.y + z.w / 2 - 0.5)}*$r" }.mkString
      filters += s"${current}zoompan=z='$zoomExpr':" +
        s"x='clip(($cxExpr)*iw-iw/zoom/2,0,iw-iw/zoom)':" +
        s"y='clip(($cyExpr)*ih-ih/zoom/2,0,ih-ih/zoom)':" +
        s"d=1:s=${W}x$H:fps=${num(fps)}[vzoom]"
      current = "[vzoom]"
    }

    // Overlays nach dem Zoom, damit Pfeile/Text dort bleiben, wo sie gezeichnet wurden
    p.overlays.zipWithIndex.foreach { case (o, i) =>
      val idx = addInput("-loop", "1", "-i", overlayFiles(o.file))
      filters += s"[$idx:v:0]scale=$W:$H,format=rgba[ov$i]"
      filters += s"$current[ov$i]overlay=0:0:enable='between(t,${num(o.start)},${num(o.end)})':shortest=1[vo$i]"
      current = s"[vo$i]"
    }
    filters += s"${current}format=yuv420p[vout]"

    // Tonspur: Abschnitte mit Versatz auf eine stille Grundspur in Videolänge mischen
    val audioLabels =
      if (p.output == "video") Nil
      else addAudio(p, paths, total, audioAvailable, args => addInput(args: _*), filters)

    val encoderArgs =
      if (useGpu) Seq("-c:v", "h264_nvenc", "-preset", "p4", "-bf", "0")
      else Seq("-c:v", "libx264", "-preset", "veryfast")
    val audioOut =
      if (audioLabels.nonEmpty) Seq("-map", "[aout]", "-c:a", "aac", "-b:a", s"${VideoCalculator.AudioBitrateKbps}k")
      else Seq()

    Seq("ffmpeg", "-y", "-v", "error") ++ inputs.result() ++
      Seq("-filter_complex", filters.result().mkString(";"), "-map", "[vout]") ++ audioOut ++
      encoderArgs ++ Seq("-b:v", s"${p.preset.bitrate}k", "-t", num(total), "-movflags", "+faststart", "-f", "mp4", outPath)
  }

  /** Nur Ton: ganze Tonspur des Projekts als MP3 (auch Ton hinter dem Videoende). None, wenn das Projekt keinen Ton hat. */
  def buildAudioCommand(
    p: EditProject,
    paths: Map[String, String],
    audioAvailable: String => Boolean,
    outPath: String
  ): Option[Seq[String]] = {
    val total = p.audio.map(s => s.at + s.end - s.start).maxOption.getOrElse(0.0)
    val inputs = Seq.newBuilder[String]
    val filters = Seq.newBuilder[String]
    var inputIndex = 0
    def addInput(args: String*): Int = { inputs ++= args; inputIndex += 1; inputIndex - 1 }

    if (addAudio(p, paths, total, audioAvailable, args => addInput(args: _*), filters).isEmpty) None
    else Some(Seq("ffmpeg", "-y", "-v", "error") ++ inputs.result() ++
      Seq("-filter_complex", filters.result().mkString(";"), "-map", "[aout]",
        "-c:a", "libmp3lame", "-b:a", s"${FFmpegUtils.AudioOnlyBitrateKbps}k", "-t", num(total), "-f", "mp3", outPath))
  }

  // Fügt die Ton-Eingänge und den Mix [aout] hinzu; liefert die Labels der Abschnitte (leer = kein Ton)
  private def addAudio(
    p: EditProject,
    paths: Map[String, String],
    total: Double,
    audioAvailable: String => Boolean,
    addInput: Seq[String] => Int,
    filters: scala.collection.mutable.Builder[String, Seq[String]]
  ): Seq[String] = {
    val audioSegs = p.audio.filter(s => s.at < total && audioAvailable(paths(s.originalId)))
    val audioLabels = audioSegs.zipWithIndex.map { case (seg, i) =>
      val idx = addInput(Seq("-ss", num(seg.start), "-t", num(seg.end - seg.start), "-i", paths(seg.originalId)))
      val delayMs = Math.round(seg.at * 1000)
      filters += s"[$idx:a:0]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS," +
        s"volume=${num(seg.volume)},adelay=$delayMs:all=1[a$i]"
      s"[a$i]"
    }
    if (audioLabels.nonEmpty) {
      filters += s"anullsrc=r=48000:cl=stereo,atrim=duration=${num(total)}[abase]"
      filters += s"[abase]${audioLabels.mkString}amix=inputs=${audioLabels.size + 1}:duration=first:normalize=0[aout]"
    }
    audioLabels
  }

  def render(
    p: EditProject,
    paths: Map[String, String],
    overlayFiles: Map[String, String],
    outPath: String
  ): Either[String, String] = {
    validate(p, overlayFiles) match {
      case Some(error) => return Left(error)
      case None =>
    }
    val sourceFps = paths.values.toSeq.distinct.flatMap(path => FFmpegUtils.getVideoInfo(path).toOption.map(_.fps)).maxOption.getOrElse(0.0)
    val audioCache = scala.collection.mutable.Map.empty[String, Boolean]
    val audioAvailable = (path: String) => audioCache.getOrElseUpdate(path, FFmpegUtils.hasAudio(path))

    if (p.output == "audio") {
      return buildAudioCommand(p, paths, audioAvailable, outPath) match {
        case Some(cmd) => FFmpegUtils.run(cmd)
        case None => Left("Das Projekt hat keinen Ton.")
      }
    }

    def run(useGpu: Boolean) =
      FFmpegUtils.run(buildCommand(p, paths, overlayFiles, sourceFps, audioAvailable, outPath, useGpu))

    // Filter laufen auf der CPU, kodiert wird per NVENC falls vorhanden
    if (FFmpegUtils.gpuAvailable) {
      run(useGpu = true) match {
        case Left(error) =>
          println(s"[EDIT] GPU-Encoding fehlgeschlagen, nutze CPU: $error")
          run(useGpu = false)
        case ok => ok
      }
    } else run(useGpu = false)
  }
}
