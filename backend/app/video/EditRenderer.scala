package video

import play.api.libs.json._
import java.io.File
import scala.sys.process._
import scala.util.Try

// Project description from the editor tab. All times in seconds,
// positions relative to the output frame (0..1).
case class EditPreset(width: Int, height: Int, fps: Double, bitrate: Long)
// Video track: segments play one after another
// speed: playback speed 0.25–4 (missing = 1); on the timeline a segment lasts (end − start) / speed
case class EditVideoSeg(originalId: String, start: Double, end: Double, speed: Double = 1.0)
// Audio track: segments are placed freely on the timeline (at = start time in the output)
case class EditAudioSeg(originalId: String, start: Double, end: Double, at: Double, volume: Double, speed: Double = 1.0)
// Zoom into the area x,y (top left) with width w; the height follows from the aspect ratio
case class EditZoom(start: Double, end: Double, x: Double, y: Double, w: Double)
// Overlay = transparent PNG in output size (the browser renders arrows, text and images)
case class EditOverlay(file: String, start: Double, end: Double)
// Free crop of the output frame (relative, 0..1); the result gets smaller accordingly
case class EditCrop(x: Double, y: Double, w: Double, h: Double) {
  def valid: Boolean = x >= 0 && y >= 0 && w > 0.01 && h > 0.01 && x + w <= 1.001 && y + h <= 1.001
}
case class EditProject(
  preset: EditPreset,
  video: Seq[EditVideoSeg],
  audio: Seq[EditAudioSeg],
  zooms: Seq[EditZoom],
  overlays: Seq[EditOverlay],
  output: String = "both", // "both", "video" (no audio) or "audio" (audio only, as MP3)
  crop: Option[EditCrop] = None
)

object EditProject {
  implicit val presetReads: Reads[EditPreset] = Json.reads[EditPreset]
  implicit val videoReads: Reads[EditVideoSeg] = Json.using[Json.WithDefaultValues].reads[EditVideoSeg]
  implicit val audioReads: Reads[EditAudioSeg] = Json.using[Json.WithDefaultValues].reads[EditAudioSeg]
  implicit val zoomReads: Reads[EditZoom] = Json.reads[EditZoom]
  implicit val overlayReads: Reads[EditOverlay] = Json.reads[EditOverlay]
  implicit val cropReads: Reads[EditCrop] = Json.reads[EditCrop]
  implicit val projectReads: Reads[EditProject] = Json.using[Json.WithDefaultValues].reads[EditProject]
}

object EditRenderer {

  // Duration of the smooth zoom in/out in seconds
  private val ZoomRamp = 0.3

  // Numbers without scientific notation and independent of the locale
  private def num(d: Double): String =
    BigDecimal(d).setScale(4, BigDecimal.RoundingMode.HALF_UP).bigDecimal.stripTrailingZeros.toPlainString

  // Speed limits as in the editor (SPEEDS in project.js)
  private val MinSpeed = 0.25
  private val MaxSpeed = 4.0

  // Audio speed as an atempo chain (each link 0.5–2), e.g. 4 → ",atempo=2,atempo=2"; speed 1 → empty
  def atempo(speed: Double): String =
    if (Math.abs(speed - 1) < 1e-6) ""
    else {
      var rest = speed
      val out = new StringBuilder
      while (rest > 2 + 1e-9) { out ++= ",atempo=2"; rest /= 2 }
      while (rest < 0.5 - 1e-9) { out ++= ",atempo=0.5"; rest /= 0.5 }
      out ++= s",atempo=${num(rest)}"
      out.toString
    }

  def validate(p: EditProject, overlayFiles: Map[String, String]): Option[String] = {
    val total = p.video.map(s => (s.end - s.start) / s.speed).sum
    val badSpeed = (v: Double) => v < MinSpeed || v > MaxSpeed
    if (p.video.isEmpty) Some("The video track is empty.")
    else if (p.video.exists(s => s.start < 0 || s.end - s.start < 0.005)) Some("Invalid video segment.")
    else if (p.video.exists(s => badSpeed(s.speed)) || p.audio.exists(s => badSpeed(s.speed)))
      Some("Speed must be between 0.25× and 4×.")
    else if (p.audio.exists(s => s.start < 0 || s.end - s.start < 0.005 || s.at < 0 || s.volume < 0))
      Some("Invalid audio segment.")
    else if (p.zooms.exists(z => z.end <= z.start || z.w <= 0 || z.w > 1 || z.x < 0 || z.y < 0 || z.x + z.w > 1.001 || z.y + z.w > 1.001))
      Some("Invalid zoom area.")
    else if (p.overlays.exists(o => o.end <= o.start || !overlayFiles.contains(o.file)))
      Some("Invalid overlay.")
    else if (p.preset.width < 16 || p.preset.height < 16 || p.preset.fps <= 0 || p.preset.bitrate <= 0)
      Some("Invalid export settings.")
    else if (total > 6 * 3600) Some("The project is too long.")
    else if (p.crop.exists(c => !c.valid)) Some("Invalid crop.")
    else if (!Set("both", "video", "audio").contains(p.output)) Some("Invalid output format.")
    else None
  }

  /** Builds the ffmpeg command. paths: originalId -> file, overlayFiles: overlay name -> PNG. */
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
    // No more fps than the fastest source, otherwise only duplicated frames
    val fps = if (sourceFps > 0) Math.min(p.preset.fps, sourceFps) else p.preset.fps
    val total = p.video.map(s => (s.end - s.start) / s.speed).sum

    val inputs = Seq.newBuilder[String]
    val filters = Seq.newBuilder[String]
    var inputIndex = 0
    def addInput(args: String*): Int = { inputs ++= args; inputIndex += 1; inputIndex - 1 }

    // Video track: each segment on its own (fast seek with -ss before -i), scaled to the output size, then concatenated
    val videoLabels = p.video.zipWithIndex.map { case (seg, i) =>
      val idx = addInput("-ss", num(seg.start), "-t", num(seg.end - seg.start), "-i", paths(seg.originalId))
      filters += s"[$idx:v:0]setpts=(PTS-STARTPTS)/${num(seg.speed)},scale=$W:$H:force_original_aspect_ratio=decrease," +
        s"pad=$W:$H:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${num(fps)},format=yuv420p[v$i]"
      s"[v$i]"
    }
    filters += s"${videoLabels.mkString}concat=n=${videoLabels.size}:v=1:a=0[vcat]"
    var current = "[vcat]"

    // Zoom: zoom factor and centre as a function of time, with a smooth ramp
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

    // Overlays after the zoom, so arrows/text stay where they were drawn
    p.overlays.zipWithIndex.foreach { case (o, i) =>
      val idx = addInput("-loop", "1", "-i", overlayFiles(o.file))
      filters += s"[$idx:v:0]scale=$W:$H,format=rgba[ov$i]"
      filters += s"$current[ov$i]overlay=0:0:enable='between(t,${num(o.start)},${num(o.end)})':shortest=1[vo$i]"
      current = s"[vo$i]"
    }
    // Crop last, so zoom and overlays sit inside the crop just like in the preview
    val crop = p.crop.map(c =>
      s"crop=trunc(iw*${num(c.w)}/2)*2:trunc(ih*${num(c.h)}/2)*2:trunc(iw*${num(c.x)}):trunc(ih*${num(c.y)}),"
    ).getOrElse("")
    filters += s"${current}${crop}format=yuv420p[vout]"

    // Audio track: mix the offset segments onto a silent base track as long as the video
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

  /** Audio only: the project's whole audio track as MP3 (including audio after the video ends). None if the project has no audio. */
  def buildAudioCommand(
    p: EditProject,
    paths: Map[String, String],
    audioAvailable: String => Boolean,
    outPath: String
  ): Option[Seq[String]] = {
    val total = p.audio.map(s => s.at + (s.end - s.start) / s.speed).maxOption.getOrElse(0.0)
    val inputs = Seq.newBuilder[String]
    val filters = Seq.newBuilder[String]
    var inputIndex = 0
    def addInput(args: String*): Int = { inputs ++= args; inputIndex += 1; inputIndex - 1 }

    if (addAudio(p, paths, total, audioAvailable, args => addInput(args: _*), filters).isEmpty) None
    else Some(Seq("ffmpeg", "-y", "-v", "error") ++ inputs.result() ++
      Seq("-filter_complex", filters.result().mkString(";"), "-map", "[aout]",
        "-c:a", "libmp3lame", "-b:a", s"${FFmpegUtils.AudioOnlyBitrateKbps}k", "-t", num(total), "-f", "mp3", outPath))
  }

  // Adds the audio inputs and the mix [aout]; returns the segment labels (empty = no audio)
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
      filters += s"[$idx:a:0]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS${atempo(seg.speed)}," +
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
        case None => Left("The project has no audio.")
      }
    }

    def run(useGpu: Boolean) =
      FFmpegUtils.run(buildCommand(p, paths, overlayFiles, sourceFps, audioAvailable, outPath, useGpu))

    // Filters run on the CPU, encoding uses NVENC if available
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
