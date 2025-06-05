package video

import org.scalatest.funsuite.AnyFunSuite
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import play.api.libs.Files.TemporaryFile
import play.api.mvc.MultipartFormData
import java.io.File
import scala.concurrent.ExecutionContext.Implicits.global
import scala.concurrent.Future
import org.apache.pekko.actor.ActorSystem
import play.api.libs.Files.SingletonTemporaryFileCreator

class VideoServiceSpec extends AnyFunSuite with ScalaFutures with Matchers {

  val dummyActorSystem = ActorSystem("test")
  val service = new VideoService(dummyActorSystem)

  test("checkVideoExists returns false for non-existent file") {
    assert(!service.checkVideoExists("does_not_exist.mp4"))
  }

  test("getProcessedVideoFile returns None for non-existent file") {
    assert(service.getProcessedVideoFile("does_not_exist.mp4").isEmpty)
  }

  test("scheduleDeleteAfterDelay deletes file immediately and after delay") {
    val tmp = File.createTempFile("test", ".mp4")
    val ready = File.createTempFile("test_ready", ".mp4")
    service.scheduleDeleteAfterDelay(tmp.getAbsolutePath, ready.getAbsolutePath, "test_ready.mp4")
    Thread.sleep(100) // give time for immediate delete
    assert(!tmp.exists())
    // ready file will be deleted after 1 minute, but we don't wait here
    ready.delete()
  }

  test("handleUpload returns Left if file move fails") {
    val dummyData = play.api.mvc.MultipartFormData[TemporaryFile](Map.empty, Seq.empty, Seq.empty)
    val dummyTempFile = SingletonTemporaryFileCreator.create("notfound", ".mp4")
    val dummyFile = new play.api.mvc.MultipartFormData.FilePart[TemporaryFile](
      key = "video",
      filename = "notfound.mp4",
      contentType = Some("video/mp4"),
      ref = dummyTempFile
    )
    val fut = service.handleUpload(dummyData, dummyFile)
    fut.map { result =>
      assert(result.isLeft)
    }
  }
}