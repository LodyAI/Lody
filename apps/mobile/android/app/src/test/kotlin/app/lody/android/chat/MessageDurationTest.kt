package app.lody.android.chat
import app.lody.android.runtime.SessionMessage
import org.junit.Assert.*
import org.junit.Test
class MessageDurationTest {
 @Test fun prefersTimestampAndSubtractsPermissionWait() {
  val message = SessionMessage("t", "assistant", "answer", false, timestamp="2026-01-01T00:00:00Z", startedAt=1767225605000, endedAt=1767225730000, permissionWaitMs=2000)
  assertEquals(128L, messageWorkSeconds(message))
 }
 @Test fun unknownAndLiveDurationsAreAbsent() {
  assertNull(messageWorkSeconds(SessionMessage("t", "assistant", "", false)))
  assertNull(messageWorkSeconds(SessionMessage("t", "assistant", "", true, startedAt=1, endedAt=20)))
 }
}
