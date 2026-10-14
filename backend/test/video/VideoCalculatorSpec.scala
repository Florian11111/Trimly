package video

import org.scalatest.funsuite.AnyFunSuite
import java.io.File
import scala.concurrent.ExecutionContext.Implicits.global

class VideoCalculatorSpec extends AnyFunSuite {

  val testVideoPath = "test/resources/testVideo.mp4"
  val testFile = new File(testVideoPath)
  val dummyDir = new File("dummyDir")

  val validInfo: Map[String, Any] = Map(
    "size" -> 1000000L,
    "framerate" -> 60.0,
    "width" -> 1920,
    "height" -> 1080,
    "bitrate" -> 4000000L,
    "duration" -> 10.0
  )

  test("process returns Left for non-existent file") {
    val conversion = VideoConversion(
      filePath = "does_not_exist.mp4",
      filePathReady = "dummy.mp4",
      startTime = Some(0),
      endTime = Some(1000),
      bitrate = Some(300_000L),
      framerate = Some(15.0),
      width = Some(320),
      height = Some(240),
      volume = Some(1.0)
    )
    val fut = VideoCalculator.process(conversion)
    fut.map { result =>
      assert(result.isLeft)
    }
  }
}
class VideoCalculatorFixesSpec extends AnyFunSuite {
  import scala.concurrent.Await
  import scala.concurrent.duration._

  val testFile = new File("test/resources/testVideo.mp4")

  private def conversion(out: File, endTime: Int, maxSizeMb: Option[Double] = None) = VideoConversion(
    filePath = testFile.getAbsolutePath,
    filePathReady = out.getAbsolutePath,
    startTime = Some(0),
    endTime = Some(endTime),
    bitrate = Some(1000L),
    framerate = Some(30.0),
    width = Some(320),
    height = Some(180),
    volume = Some(1.0),
    maxSizeMb = maxSizeMb
  )

  test("endTime slightly beyond video duration is clamped instead of rejected") {
    val out = File.createTempFile("clamp", ".mp4")
    val info = FFmpegUtils.getVideoInfo(testFile.getAbsolutePath).toOption.get
    val result = Await.result(VideoCalculator.process(conversion(out, (info.duration * 1000).toInt + 50)), 2.minutes)
    out.delete()
    assert(result.isRight, result)
  }

  test("too small maxSizeMb is rejected with a message") {
    val out = File.createTempFile("tiny", ".mp4")
    val result = Await.result(VideoCalculator.process(conversion(out, 10000, Some(0.01))), 2.minutes)
    out.delete()
    assert(result.left.exists(_.contains("zu klein")), result)
  }

  test("maxSizeMb keeps output below the limit") {
    val out = File.createTempFile("limited", ".mp4")
    val result = Await.result(VideoCalculator.process(conversion(out, 10000, Some(0.5)).copy(bitrate = Some(5000L), width = Some(1280), height = Some(720))), 2.minutes)
    val size = out.length()
    out.delete()
    assert(result.isRight, result)
    assert(size <= 0.5 * 1024 * 1024 * 1.05, s"size=$size")
  }

  private def probe(file: File, entries: String, select: String = "v:0"): String = {
    import scala.sys.process._
    Seq("ffprobe", "-v", "error", "-select_streams", select, "-show_entries", entries,
      "-read_intervals", "%+#1", "-of", "csv=p=0", file.getAbsolutePath).!!.trim
  }

  test("audioOnly produces an mp3 with only an audio stream") {
    val out = File.createTempFile("calc_audio", ".mp3")
    val result = Await.result(VideoCalculator.process(conversion(out, 3000).copy(audioOnly = true)), 2.minutes)
    assert(result.isRight, result)
    val audio = probe(out, "stream=codec_name", "a")
    val video = probe(out, "stream=codec_type", "v")
    out.delete()
    assert(audio == "mp3", audio)
    assert(video.isEmpty, video)
  }

  test("removeAudio produces a file without audio stream") {
    val out = File.createTempFile("noaudio", ".mp4")
    val result = Await.result(VideoCalculator.process(conversion(out, 3000).copy(removeAudio = true)), 2.minutes)
    val audio = probe(out, "stream=codec_type", "a")
    out.delete()
    assert(result.isRight, result)
    assert(audio.isEmpty, audio)
  }

  test("29.97 fps source gets sane timestamps (no grey video)") {
    import scala.sys.process._
    val src = File.createTempFile("ntsc", ".mp4")
    val out = File.createTempFile("ntsc_out", ".mp4")
    Seq("ffmpeg", "-v", "error", "-y", "-i", testFile.getAbsolutePath, "-t", "4", "-r", "30000/1001",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src.getAbsolutePath).!!
    val conv = conversion(out, 3000).copy(filePath = src.getAbsolutePath, framerate = Some(30000.0 / 1001),
      width = Some(1280), height = Some(720))
    val result = Await.result(VideoCalculator.process(conv), 2.minutes)
    val firstDts = probe(out, "packet=dts").toLong
    val timeBase = probe(out, "stream=time_base").split("/").map(_.toDouble)
    src.delete(); out.delete()
    assert(result.isRight, result)
    assert(firstDts * timeBase(0) / timeBase(1) > -1.0, s"first dts $firstDts")
  }

  test("trimOnly cuts without re-encoding") {
    val out = File.createTempFile("trim", ".mp4")
    val result = Await.result(VideoCalculator.process(conversion(out, 5000).copy(trimOnly = true)), 2.minutes)
    val probed = FFmpegUtils.getVideoInfo(out.getAbsolutePath)
    out.delete()
    assert(result.isRight, result)
    // Auflösung bleibt beim Original (2560x1440), obwohl 320x180 angefragt war
    assert(probed.toOption.map(i => (i.width, i.height)).contains((2560, 1440)), probed)
  }
}
