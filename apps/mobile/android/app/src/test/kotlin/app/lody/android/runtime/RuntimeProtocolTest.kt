package app.lody.android.runtime
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
class RuntimeProtocolTest {
 private val fixtures=JSONObject(File(System.getProperty("runtime.fixtures")).readText())
 @Test fun sessionTextKeepsOrderAndStreamingButOmitsToolPayloads() {
  val body="""{"v":1,"status":"live","entries":[{"id":"u","role":"user","finished":true,"items":[{"type":"text","text":"hello"}]},{"id":"a","role":"assistant","finished":false,"items":[{"type":"text","text":"First"},{"type":"tool_call","title":"private payload"},{"type":"text","text":"Second"},{"type":"proposed_plan","status":"cleared","markdown":"old plan"}]}]}"""
  val frame=JSONObject().put("type","session").put("sessionId","s").put("session",body)
  val snapshot=(RuntimeProtocol.event(frame) as RuntimeEvent.SessionUpdated).snapshot
  assertEquals("live",snapshot.status)
  assertEquals(listOf(SessionMessage("u","user","hello",false),SessionMessage("a","assistant","First\n\nSecond",true)),snapshot.messages.map { it.copy(items = emptyList()) })
 }
 @Test fun fileOnlyTurnsRetainAllFilesAndStats() {
  val files = org.json.JSONArray()
  repeat(9) { files.put(JSONObject().put("path", "src/file$it.kt").put("add", it).put("del", 2)) }
  files.put(JSONObject().put("path", ""))
  val entry = JSONObject().put("id", "a").put("role", "assistant").put("finished", true).put("items", org.json.JSONArray()).put("fileDiffs", files)
  val body = JSONObject().put("v", 1).put("status", "live").put("entries", org.json.JSONArray().put(entry))
  val event = JSONObject().put("type", "session").put("sessionId", "s").put("session", body.toString())
  val messages = (RuntimeProtocol.event(event) as RuntimeEvent.SessionUpdated).snapshot.messages
  assertEquals(9, messages.single().files.size)
  assertEquals(FileChange("src/file8.kt", 8, 2), messages.single().files.last())
 }
 @Test fun composerRoleIsKnownOnlyWhenTheLatestTurnSaysSo() {
  fun composer(json: String) = (RuntimeProtocol.event(JSONObject().put("type","session").put("sessionId","s")
   .put("session","""{"v":1,"status":"live","composer":$json,"entries":[]}""")) as RuntimeEvent.SessionUpdated).snapshot.composer!!
  assertEquals(RunChoice(agentRoleId = "r", roleKnown = true), composer("""{"agentRoleId":"r"}"""))
  assertEquals(RunChoice(roleKnown = true), composer("""{"agentRoleId":null}"""))
  assertEquals(RunChoice(), composer("""{}"""))
 }
 @Test fun composerChoiceAndUserAttachmentsAreParsed() {
  val body="""{"v":1,"status":"live","composer":{"modelId":"gpt","modeId":"plan","effort":"high","configOptionValues":{"fast":true}},"entries":[{"id":"u","role":"user","finished":true,"items":[{"type":"image_group","images":[{"id":"i1","fileName":"a.png"},{"id":"i2","fileName":"b.png"}]},{"type":"file","file":{"id":"f1","fileName":"notes.md"}}]}]}"""
  val snapshot=(RuntimeProtocol.event(JSONObject().put("type","session").put("sessionId","s").put("session",body)) as RuntimeEvent.SessionUpdated).snapshot
  // Agent switches (Fast) come back so the chip and sheet reopen on them; no Role was said.
  assertEquals(RunChoice("gpt","plan","high",mapOf("fast" to true)),snapshot.composer)
  // An attachment-only user turn stays in the transcript.
  assertEquals(listOf(MessageAttachment("a.png",true),MessageAttachment("b.png",true),MessageAttachment("notes.md",false)),snapshot.messages.single().attachments)
 }
 @Test fun sessionProjectionIsNotDropped() {
  val frame=JSONObject().put("type","session").put("sessionId","s").put("session", """{"v":1,"status":"live","entries":[]}""")
  assertNotNull(RuntimeProtocol.event(frame))
 }
 @Test fun sharedFixturesDecodeToTypedResults() {
  assertEquals(setOf("ping","setActive","probeSchema"),RuntimeProtocol.capabilities(fixtures.getJSONObject("hostReady")))
  val event=RuntimeProtocol.event(fixtures.getJSONObject("catalog")) as RuntimeEvent.CatalogUpdated
  assertEquals("中文 😀",event.snapshot.sessions.single().title);assertEquals(7L,event.snapshot.revision)
  assertEquals(RuntimeEvent.Synced(7,2),RuntimeProtocol.event(fixtures.getJSONObject("synced")))
  assertEquals(RuntimeEvent.GrantRequested,RuntimeProtocol.event(fixtures.getJSONObject("grant")))
  assertEquals(setOf("m"),RuntimeProtocol.schema(fixtures.getJSONObject("schema")).machineIds)
 }
 @Test fun networkFailureCannotBeMistakenForLiveAndDoesNotLeakRemoteText() {
  assertEquals(RuntimeEvent.SyncFailed("network_unavailable"),RuntimeProtocol.event(JSONObject("""{"type":"networkStatus","status":"unavailable"}""")))
  assertEquals(RuntimeEvent.SyncFailed("sync_failed"),RuntimeProtocol.event(JSONObject("""{"type":"syncError","reason":"private server contents"}""")))
 }
 @Test fun incompatibleOrIncompleteHandshakeFailsClosed() {
  assertThrows(Exception::class.java){RuntimeProtocol.capabilities(JSONObject("""{"protocol":1,"capabilities":["ping"]}"""))}
  assertThrows(Exception::class.java){RuntimeProtocol.capabilities(JSONObject("""{"protocol":2,"capabilities":["ping"]}"""))}
 }
 @Test fun malformedRequiredFieldsAreRejectedButFutureEventsIgnored() {
  assertThrows(Exception::class.java){RuntimeProtocol.event(JSONObject("""{"type":"synced","revision":"7","streams":2}"""))}
  assertThrows(Exception::class.java){RuntimeProtocol.event(JSONObject("""{"type":"catalog","revision":7,"catalog":{}}"""))}
  assertNull(RuntimeProtocol.event(JSONObject("""{"type":"futureEvent"}""")))
 }
}
