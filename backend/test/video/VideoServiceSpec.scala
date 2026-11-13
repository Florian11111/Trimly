package video

import org.scalatest.funsuite.AnyFunSuite
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import play.api.libs.Files.TemporaryFile
import play.api.mvc.MultipartFormData
import java.io.File
import scala.concurrent.ExecutionContext.Implicits.global
import scala.concurrent.{Await, Future}
import scala.concurrent.duration._
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

  test("handleProcess reports an unknown original as missing") {
    val data = MultipartFormData[TemporaryFile](Map.empty, Seq.empty, Seq.empty)
    val result = Await.result(service.handleProcess(data, "does_not_exist"), 10.seconds)
    assert(result == Left(None))
  }

  test("a stored original can be found again by its id") {
    val tmp = SingletonTemporaryFileCreator.create("stored", ".mp4")
    val part = MultipartFormData.FilePart[TemporaryFile]("video", "clip.mp4", Some("video/mp4"), tmp)
    val id = service.storeOriginal(part)
    val path = service.originalPath(id)
    assert(path.exists(p => new File(p).isFile), path)
    path.foreach(p => new File(p).delete())
  }
}
