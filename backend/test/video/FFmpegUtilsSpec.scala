package video

import org.scalatest.funsuite.AnyFunSuite
import java.io.{File}
import scala.util.Random
import scala.util.Try

class FFmpegUtilsSpec extends AnyFunSuite {

  val testVideoPath = "test/resources/testVideo.mp4"
  val testFile = new File(testVideoPath)
  val absolutePath = testFile.getAbsolutePath
  val outputDir = new File("test/output")
  outputDir.mkdirs()

  // --- getVideoInfo ---

  test("getVideoInfo should return correct metadata for a valid video file") {
    assert(testFile.exists(), s"Testvideo nicht gefunden: $testVideoPath")

    val startTime = System.nanoTime()
    val resultOpt = FFmpegUtils.getVideoInfo(absolutePath)
    val durationMs = (System.nanoTime() - startTime) / 1_000_000.0
    println(f"getVideoInfo for valid video: $durationMs%.2f ms")

    assert(resultOpt.isDefined, "getVideoInfo sollte Some(...) zurückgeben")
    val result = resultOpt.get

    assert(result("duration").asInstanceOf[Double] > 0)
    assert(result("fps").asInstanceOf[Double] > 0)
    assert(result("size").asInstanceOf[Long] > 0)
    assert(result("stream_bit_rate").asInstanceOf[Int] > 0)
    assert(result("bit_rate").asInstanceOf[Long] > 0)
    assert(result("height").asInstanceOf[Int] > 0)
    assert(result("width").asInstanceOf[Int] > 0)
  }

  test("getVideoInfo should return None for a non-existent file") {
    val startTime = System.nanoTime()
    val result = FFmpegUtils.getVideoInfo("non_existent_file.mp4")
    val durationMs = (System.nanoTime() - startTime) / 1_000_000.0
    println(f"getVideoInfo for non-existent file: $durationMs%.2f ms")

    assert(result.isEmpty)
  }

  // --- processVideo ---

  test("processVideo should process a valid video segment with volume and resolution change") {
    assume(testFile.exists(), s"Testvideo nicht gefunden: $testVideoPath")

    val outputOpt = FFmpegUtils.processVideo(
      videoPath = absolutePath,
      startTimeMs = 0,
      endTimeMs = 3000,
      volumeFactor = 1.5,
      outputDir = outputDir,
      width = Some(320),
      height = Some(240),
      bitrate = Some(300_000L),
      framerate = Some(15.0)
    )

    assert(outputOpt.isDefined)
    val outputFile = outputOpt.get
    assert(outputFile.exists(), "Ausgabedatei wurde nicht erstellt")
    assert(outputFile.length() > 0)

    println(s"Output file: ${outputFile.getAbsolutePath}")
  }

  test("processVideo should return None for non-existent input file") {
    val result = FFmpegUtils.processVideo(
      videoPath = "does_not_exist.mp4",
      startTimeMs = 0,
      endTimeMs = 1000,
      volumeFactor = 1.0,
      outputDir = outputDir
    )
    assert(result.isEmpty)
  }
}
