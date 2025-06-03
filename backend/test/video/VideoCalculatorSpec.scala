package video

import org.scalatest.funsuite.AnyFunSuite
import java.io.File

class VideoCalculatorSpec extends AnyFunSuite {

  val testVideoPath = "test/resources/testVideo.mp4"
  val testFile = new File(testVideoPath)
  val dummyDir = new File("dummyDir")

  val validInfo: Map[String, Any] = Map(
    "size" -> testFile.length(),
    "framerate" -> 60.0,
    "width" -> 1920,
    "height" -> 1080,
    "bitrate" -> 4000000L,
    "duration" -> 10.0
  )

  test("distributeReduction should distribute reduction factors correctly") {
    val factors = VideoCalculator.distributeReduction(
      overallMultiplier = 0.5,
      origFramerate = 60.0,
      origWidth = 1920,
      origHeight = 1080,
      origBitrate = 4000000L
    )
    assert(factors.fps <= 1.0 && factors.fps > 0)
    assert(factors.res <= 1.0 && factors.res > 0)
    assert(factors.bitrate <= 1.0 && factors.bitrate > 0)
  }

  test("VideoCalculatorWithSizeLimit returns error if size not found") {
    val params = VideoCalculator.ProcessingParams(0, 1000, maxSizeMb = Some(1.0))
    val result = VideoCalculator.VideoCalculatorWithSizeLimit(testFile, dummyDir, params, Map())
    assert(result.isLeft)
    assert(result.left.get.contains("Size not found"))
  }

  test("VideoCalculatorWithSizeLimit returns error if target size too small") {
    val params = VideoCalculator.ProcessingParams(0, 1000, maxSizeMb = Some(0.01))
    val info = validInfo.updated("size", testFile.length())
    val result = VideoCalculator.VideoCalculatorWithSizeLimit(testFile, dummyDir, params, info)
    assert(result.isLeft)
    assert(result.left.get.contains("Target size too small"))
  }

  test("calculateFPSMultiplier returns correct multiplier for high FPS") {
    val params = VideoCalculator.ProcessingParams(0, 1000)
    val info = validInfo.updated("framerate", 60.0)
    val result = VideoCalculator.calculateFPSMultiplier(testFile, dummyDir, params, info)
    assert(result.isRight)
    val (mult, fps) = result.right.get
    assert(fps == 30.0)
    assert(mult < 1.0)
  }

  test("calculateFPSMultiplier returns error for missing framerate") {
    val params = VideoCalculator.ProcessingParams(0, 1000)
    val info = validInfo - "framerate"
    val result = VideoCalculator.calculateFPSMultiplier(testFile, dummyDir, params, info)
    assert(result.isLeft)
  }

  test("calculatLenghtMultiplier returns correct ratio") {
    val params = VideoCalculator.ProcessingParams(0, 5000)
    val info = validInfo.updated("duration", 10.0)
    val result = VideoCalculator.calculatLenghtMultiplier(testFile, dummyDir, params, info)
    assert(result.isRight)
    assert(result.right.get > 0.0 && result.right.get <= 1.0)
  }

  test("calculatLenghtMultiplier returns error for missing duration") {
    val params = VideoCalculator.ProcessingParams(0, 1000)
    val info = validInfo - "duration"
    val result = VideoCalculator.calculatLenghtMultiplier(testFile, dummyDir, params, info)
    assert(result.isLeft)
  }
}