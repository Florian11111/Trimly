package video

import org.scalatest.funsuite.AnyFunSuite
import java.io.File

class FFmpegUtilsSpec extends AnyFunSuite {

  val testVideoPath = "test/resources/testVideo.mp4"
  val testFile = new File(testVideoPath)

  test("getVideoInfo returns Left for non-existent file") {
    val result = FFmpegUtils.getVideoInfo("does_not_exist.mp4")
    assert(result.isLeft)
  }

  test("getVideoInfo returns Right for valid file") {
    if (testFile.exists()) {
      val result = FFmpegUtils.getVideoInfo(testFile.getAbsolutePath)
      assert(result.isRight)
      val info = result.right.get
      // weitere sinnvolle Checks, z.B.:
      assert(info.duration > 0)
    }
  }

  test("processVideo returns Left for non-existent input file") {
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
    val result = FFmpegUtils.processVideo(conversion)
    assert(result.isLeft)
  }

  test("processVideo returns Right for valid input file") {
    if (testFile.exists()) {
      val conversion = VideoConversion(
        filePath = testFile.getAbsolutePath,
        filePathReady = "dummy.mp4",
        startTime = Some(0),
        endTime = Some(1000),
        bitrate = Some(300_000L),
        framerate = Some(15.0),
        width = Some(320),
        height = Some(240),
        volume = Some(1.0)
      )
      val result = FFmpegUtils.processVideo(conversion)
      assert(result.isRight)
    }
  }
}
