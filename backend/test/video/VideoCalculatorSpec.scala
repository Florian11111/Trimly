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