package video

import org.scalatest.funsuite.AnyFunSuite
import java.io.File

class FFmpegUtilsSpec extends AnyFunSuite {

  val testVideoPath = "test/resources/testVideo.mp4"
  val testFile = new File(testVideoPath)
  val absolutePath = testFile.getAbsolutePath

  test("getVideoInfo should return correct metadata (sec, bitrate, fps, width, height, byte-size) for a valid video file") {
    assert(testFile.exists(), s"Testvideo nicht gefunden: $testVideoPath")

    val resultOpt = FFmpegUtils.getVideoInfo(absolutePath)
    assert(resultOpt.isDefined, "getVideoInfo sollte Some(...) zurückgeben")

    val result = resultOpt.get

    assert(result("duration").isInstanceOf[Double] && result("duration").asInstanceOf[Double] > 0)
    assert(result("fps").isInstanceOf[Double] && result("fps").asInstanceOf[Double] > 0)
    assert(result("size").isInstanceOf[Long] && result("size").asInstanceOf[Long] > 0)

    assert(result("stream_bit_rate").isInstanceOf[Int] && result("stream_bit_rate").asInstanceOf[Int] > 0)
    assert(result("bit_rate").isInstanceOf[Long] && result("bit_rate").asInstanceOf[Long] > 0)

    assert(result("height").isInstanceOf[Int] && result("height").asInstanceOf[Int] > 0)
    assert(result("width").isInstanceOf[Int] && result("width").asInstanceOf[Int] > 0)
  }

  test("getVideoInfo should return None for a non-existent file") {
    val result = FFmpegUtils.getVideoInfo("non_existent_file.mp4")
    assert(result.isEmpty)
  }

  // ----------------------------------------------------------

  test("getAudioInfo should return mean and max volume for a valid video file") {
    assert(testFile.exists(), s"Testvideo nicht gefunden: $testVideoPath")

    val audioInfoOpt = FFmpegUtils.getAudioInfo(absolutePath)
    assert(audioInfoOpt.isDefined, "getAudioInfo sollte Some(...) zurückgeben")

    val audioInfo = audioInfoOpt.get
    assert(audioInfo.contains("mean_volume_db"))
    assert(audioInfo.contains("max_volume_db"))

    val meanVol = audioInfo("mean_volume_db").asInstanceOf[Double]
    val maxVol = audioInfo("max_volume_db").asInstanceOf[Double]

    assert(meanVol.isFinite, "mean_volume_db sollte eine gültige Zahl sein")
    assert(maxVol.isFinite, "max_volume_db sollte eine gültige Zahl sein")
  }

  test("getAudioInfo should return None for a non-existent file") {
    val result = FFmpegUtils.getAudioInfo("non_existent_file.mp4")
    assert(result.isEmpty)
  }

  test("getAudioInfo should handle files with no audio stream gracefully") {
    val noAudioFilePath = "test/resources/testVideoNoAudio.mp4"
    val noAudioFile = new File(noAudioFilePath)

    if (noAudioFile.exists()) {
        val result = FFmpegUtils.getAudioInfo(noAudioFile.getAbsolutePath)
        val audioInfo = result.get
        assert(audioInfo.contains("mean_volume_db"))
        assert(audioInfo.contains("max_volume_db"))
        println(audioInfo("mean_volume_db").asInstanceOf[Double])

        assert(audioInfo("mean_volume_db").asInstanceOf[Double] < -90)
        assert(audioInfo("max_volume_db").asInstanceOf[Double] < -90)

        assert(result.isDefined || result.isEmpty)
        } else {
            cancel(s"Kein Testvideo ohne Audio gefunden unter $noAudioFilePath")
        }
    }

}
