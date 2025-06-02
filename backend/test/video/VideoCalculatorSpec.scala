package video

import org.scalatest.funsuite.AnyFunSuite
import java.io.File

class VideoCalculatorSpec extends AnyFunSuite {

  val testVideoPath = "test/resources/testVideo.mp4"
  val testFile = new File(testVideoPath)
  val outputDir = new File("test/output")
  outputDir.mkdirs()

  test("VideoCalculator should process video with valid parameters") {
    assume(testFile.exists(), s"Testvideo nicht gefunden: $testVideoPath")

    val params = VideoCalculator.ProcessingParams(
      startTimeMs = 0,
      endTimeMs = 3000,
      volumeFactor = 1.2,
      width = Some(320),
      height = Some(240),
      framerate = Some(15.0),
      bitrate = Some(500_000L),
      maxSizeMb = Some(10.0)
    )

    val result = VideoCalculator.process(testFile, outputDir, params)
    assert(result.isRight, s"Expected success but got error: ${result.left.getOrElse("")}")

    val outputFile = result.toOption.get
    assert(outputFile.exists())
    assert(outputFile.length() > 0)
  }

  test("VideoCalculator should return error if start > end") {
    val params = VideoCalculator.ProcessingParams(
      startTimeMs = 3000,
      endTimeMs = 1000
    )
    val result = VideoCalculator.process(testFile, outputDir, params)
    assert(result.isLeft)
    assert(result.left.get.contains("Start time must be less"))
  }

  test("VideoCalculator should return error if file is too big") {
    val params = VideoCalculator.ProcessingParams(
      startTimeMs = 0,
      endTimeMs = 3000,
      maxSizeMb = Some(0.0001) // Extrem klein setzen
    )
    val result = VideoCalculator.process(testFile, outputDir, params)
    assert(result.isLeft)
    assert(result.left.get.contains("too large"))
  }
}
