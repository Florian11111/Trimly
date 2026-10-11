package video

import org.scalatest.funsuite.AnyFunSuite
import java.io.File
import scala.sys.process._

class EditRendererSpec extends AnyFunSuite {

  val testFile = new File("test/resources/testVideo.mp4")
  val path = testFile.getAbsolutePath
  val paths = Map("a" -> path)
  val preset = EditPreset(640, 360, 30, 1500)

  private def probe(file: File, args: String*): String =
    (Seq("ffprobe", "-v", "error") ++ args :+ file.getAbsolutePath).!!.trim

  // RGB-Wert eines Pixels zum Zeitpunkt t
  private def pixel(file: File, t: Double, x: Int, y: Int): Seq[Int] = {
    val bytes = new java.io.ByteArrayOutputStream()
    (Seq("ffmpeg", "-v", "error", "-ss", t.toString, "-i", file.getAbsolutePath, "-frames:v", "1",
      "-vf", s"crop=1:1:$x:$y,format=rgb24", "-f", "rawvideo", "-") #> bytes).!
    bytes.toByteArray.take(3).map(_ & 0xff).toSeq
  }

  private def yellowOverlay(): File = {
    val f = File.createTempFile("overlay", ".png")
    Seq("ffmpeg", "-v", "error", "-y", "-f", "lavfi",
      "-i", "color=yellow:s=200x100,format=rgba,pad=640:360:0:0:color=black@0",
      "-frames:v", "1", f.getAbsolutePath).!!
    f
  }

  test("renders two clips, detached audio, zoom and a timed overlay") {
    val overlay = yellowOverlay()
    val out = File.createTempFile("edit", ".mp4")
    val project = EditProject(
      preset = preset,
      video = Seq(EditVideoSeg("a", 2, 4), EditVideoSeg("a", 10, 11.5)),
      audio = Seq(EditAudioSeg("a", 5, 6, at = 1.0, volume = 0.5)),
      zooms = Seq(EditZoom(2.0, 3.0, 0.5, 0.5, 0.5)),
      overlays = Seq(EditOverlay("overlay_0", 0.5, 1.5))
    )
    val result = EditRenderer.render(project, paths, Map("overlay_0" -> overlay.getAbsolutePath), out.getAbsolutePath)
    assert(result.isRight, result)

    val duration = probe(out, "-show_entries", "format=duration", "-of", "csv=p=0").toDouble
    assert(Math.abs(duration - 3.5) < 0.15, s"duration=$duration")
    assert(probe(out, "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0") == "audio")
    assert(probe(out, "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0") == "640,360")

    // Overlay nur zwischen 0.5s und 1.5s sichtbar (gelb oben links)
    val during = pixel(out, 1.0, 50, 50)
    val after = pixel(out, 2.5, 50, 50)
    assert(during(0) > 200 && during(1) > 200 && during(2) < 80, s"during=$during")
    assert(!(after(0) > 200 && after(1) > 200 && after(2) < 80), s"after=$after")

    overlay.delete(); out.delete()
  }

  test("project without audio segments renders video only") {
    val out = File.createTempFile("edit_noaudio", ".mp4")
    val project = EditProject(preset, Seq(EditVideoSeg("a", 0, 1)), Seq.empty, Seq.empty, Seq.empty)
    val result = EditRenderer.render(project, paths, Map.empty, out.getAbsolutePath)
    assert(result.isRight, result)
    assert(probe(out, "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0").isEmpty)
    out.delete()
  }

  test("validate rejects broken projects") {
    val ok = EditProject(preset, Seq(EditVideoSeg("a", 0, 1)), Seq.empty, Seq.empty, Seq.empty)
    assert(EditRenderer.validate(ok, Map.empty).isEmpty)
    assert(EditRenderer.validate(ok.copy(video = Seq.empty), Map.empty).isDefined)
    assert(EditRenderer.validate(ok.copy(zooms = Seq(EditZoom(0, 1, 0.8, 0, 0.5))), Map.empty).isDefined)
    assert(EditRenderer.validate(ok.copy(overlays = Seq(EditOverlay("overlay_9", 0, 1))), Map.empty).isDefined)
  }

  test("project JSON from the frontend parses") {
    val json = """{"preset":{"width":1280,"height":720,"fps":30,"bitrate":2500},
      "video":[{"originalId":"a","start":0,"end":1.5}],
      "audio":[{"originalId":"a","start":0,"end":1.5,"at":0,"volume":1}],
      "zooms":[{"start":0.2,"end":1,"x":0.1,"y":0.1,"w":0.5}],
      "overlays":[{"file":"overlay_0","start":0,"end":1}]}"""
    val parsed = play.api.libs.json.Json.parse(json).as[EditProject](EditProject.projectReads)
    assert(parsed.video.head.end == 1.5)
    assert(parsed.zooms.head.w == 0.5)
  }
}
