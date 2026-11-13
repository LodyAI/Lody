package app.lody.android.runtime
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
class RuntimeProtocolTest {
 private val fixtures=JSONObject(File(System.getProperty("runtime.fixtures")).readText())
 private fun operationMessages(items: String): List<SessionMessage> = (RuntimeProtocol.event(JSONObject().put("type", "session").put("sessionId", "s")
  .put("session", """{"v":1,"status":"live","entries":[{"id":"event","role":"system","items":$items}]}""")) as RuntimeEvent.SessionUpdated).snapshot.messages
 @Test fun operationProgressAndRepliesSurviveTheNativeSessionBoundary() {
  val progress = operationMessages("""[{"itemId":"progress","rev":1,"type":"operation_progress","operation":{"cards":[{"id":"0","kind":"created","sessionId":"child","label":"Research","status":"running"}],"notices":[]}}]""").single()
  assertEquals("system", progress.role)
  assertEquals(OperationCard("child", "Research", "running", null), progress.operations.single().cards.single())
  val reply = operationMessages("""[{"itemId":"receipt","rev":1,"type":"operation_completion","operation":{"cards":[{"id":"0","kind":"reply","sessionId":"child","status":"succeeded","reply":"The answer"}],"notices":[]}}]""").single().operations.single()
  assertFalse(reply.creates)
  assertEquals("The answer", reply.cards.single().reply)
 }
 @Test fun savedReplyRetainsFullMarkdownAndUpstreamTruncationIndependentlyOfDetail() {
  val full = "# Saved answer\n\n" + "Long reply with **formatting**.\n".repeat(40)
  val card = JSONObject().put("kind", "reply").put("sessionId", "deleted-target")
   .put("status", "succeeded").put("detail", "Separate detail").put("reply", full).put("replyTruncated", true)
  val item = JSONObject().put("type", "operation_completion").put("itemId", "saved")
   .put("operation", JSONObject().put("cards", org.json.JSONArray().put(card)))
  val decoded = operationMessages(org.json.JSONArray().put(item).toString()).single().operations.single().cards.single()
  assertEquals(full, decoded.reply)
  assertEquals("Separate detail", decoded.detail)
  assertTrue(decoded.replyTruncated)
  assertNull(app.lody.android.chat.SessionRelations.target(decoded.sessionId, emptyList()))
  card.remove("replyTruncated")
  assertFalse(operationMessages(org.json.JSONArray().put(item).toString()).single().operations.single().cards.single().replyTruncated)
 }
 @Test fun projectedSuppressionKeepsFailuresAndCancellationWithoutInventingTargets() {
  val events = operationMessages("""[{"itemId":"receipt","rev":1,"type":"operation_completion","operation":{"cards":[],"notices":[{"kind":"partial"},{"kind":"failed","detail":"Second: Machine offline"},{"kind":"cancelled","detail":"Third"}]}}]""").single().operations
  assertEquals(listOf("partial", "failed", "cancelled"), events.map { it.outcome })
  assertEquals("Second: Machine offline", events[1].error)
  assertTrue(events.all { it.cards.isEmpty() })
  assertTrue(operationMessages("""[{"itemId":"suppressed","rev":1,"type":"operation_completion","operation":{"cards":[],"notices":[]}}]""").isEmpty())
  val unknown = operationMessages("""[{"itemId":"batch","rev":1,"type":"operation_completion_batch","operation":{"cards":[],"notices":[{"kind":"batchUnknown","count":1}]}}]""").single().operations.single()
  assertTrue(unknown.deliveryUnknown)
  assertEquals(1, unknown.memberCount)
 }
 @Test fun batchProjectionPreservesMixedCreateReplyAndFailureDetails() {
  val events = operationMessages("""[{"itemId":"batch","rev":2,"type":"operation_completion_batch","operation":{"cards":[{"id":"a/0","kind":"created","sessionId":"first","status":"failed","detail":"Dispatch failed"},{"id":"b/0","kind":"reply","sessionId":"second","status":"succeeded","reply":"Finished"}],"notices":[{"kind":"batch","count":3},{"kind":"failed","detail":"Cannot dispatch"}]}}]""").single().operations
  assertEquals(3, events[0].memberCount)
  assertEquals("Cannot dispatch", events[1].error)
  assertTrue(events[2].creates)
  assertEquals("Dispatch failed", events[2].cards.single().detail)
  assertFalse(events[3].creates)
  assertEquals("Finished", events[3].cards.single().reply)
  assertTrue(operationMessages("""[{"type":"unknown"},{"type":"operation_completion"}]""").isEmpty())
 }
 @Test fun usageProjectionPrefersContextThenFiveHours() {
  fun usage(json: String): SessionUsage? = (RuntimeProtocol.event(JSONObject().put("type", "session").put("sessionId", "s")
   .put("session", """{"v":1,"status":"live","entries":[],"usage":$json}""")) as RuntimeEvent.SessionUpdated).snapshot.usage
  val quota = """"quota":{"name":"Codex","windows":[{"duration":604800,"usedPercent":29},{"duration":18000,"usedPercent":0,"resetsAt":1900000000}]}"""
  assertFalse(usage("{}")!!.visible)
  assertFalse(usage("{$quota}")!!.visible)
  val eligible = usage("{\"quotaEligible\":true,\"modelId\":\"codex-model\",\"modelLabel\":\"Selected model\",$quota}")!!
  assertEquals("codex-model", eligible.modelId)
  assertEquals("Selected model", eligible.quota!!.name)
  assertEquals(0.0, eligible.triggerPercent!!, 0.0)
  assertEquals(listOf(604800.0, 18000.0), eligible.windows.map { it.duration })
  assertEquals(1900000000.0, eligible.windows.last().resetsAt!!, 0.0)
  val context = usage("{\"context\":{\"used\":250,\"size\":200},$quota}")!!
  assertEquals(100.0, context.triggerPercent!!, 0.0)
  assertEquals(250.0, context.context!!.used, 0.0)
  assertFalse(usage("{\"context\":{\"used\":20,\"size\":0}}")!!.visible)
  assertTrue(usage("{\"isContextCompacting\":true}")!!.visible)
  assertNull(usage("null"))
 }
 @Test fun malformedUsageDoesNotInventQuotaAndEmptyReportedPlanSurvives() {
  val parsed = SessionUsageJson.parse(JSONObject("""{"quotaEligible":true,"context":{"size":100,"used":-1},"quota":{"windows":[{"usedPercent":"20"},{"usedPercent":120,"duration":-3,"resetsAt":0}]}}"""))!!
  assertEquals(0.0, parsed.context!!.percent, 0.0)
  assertEquals(100.0, parsed.windows.single().usedPercent, 0.0)
  assertNull(parsed.windows.single().duration)
  assertNull(parsed.windows.single().resetsAt)
  val empty = SessionUsageJson.parse(JSONObject("""{"quotaEligible":true,"quota":{"windows":[]}}"""))!!
  assertNotNull(empty.quota)
  assertFalse(empty.visible)
 }
 @Test fun sessionTextKeepsOrderAndStreamingButOmitsToolPayloads() {
  val body="""{"v":1,"status":"live","entries":[{"id":"u","role":"user","finished":true,"items":[{"type":"text","text":"hello"}]},{"id":"a","role":"assistant","finished":false,"items":[{"type":"text","text":"First"},{"type":"tool_call","title":"private payload"},{"type":"text","text":"Second"},{"type":"proposed_plan","status":"cleared","markdown":"old plan"}]}]}"""
  val frame=JSONObject().put("type","session").put("sessionId","s").put("session",body)
  val snapshot=(RuntimeProtocol.event(frame) as RuntimeEvent.SessionUpdated).snapshot
  assertEquals("live",snapshot.status)
  assertEquals(listOf(SessionMessage("u","user","hello",false),SessionMessage("a","assistant","First\n\nSecond",true)),snapshot.messages.map { it.copy(items = emptyList()) })
 }
 @Test fun planApprovalCarriesItsPlanOptionsAndSettledOutcome() {
  val body="""{"v":1,"status":"live","entries":[{"id":"a","role":"assistant","finished":false,"items":[{"itemId":"p","type":"proposed_plan","status":"delta","markdown":"1. Draft"},{"itemId":"x","type":"tool_call","kind":"switch_mode","title":"Ready to code?","status":"pending","hasDetail":true,"plan":"1. Build","permission":{"requestId":"r","pending":true,"kind":"permission","options":[{"optionId":"yes","name":"Yes","kind":"allow_once"},{"optionId":"","name":"Broken"},{"optionId":"no","name":"No, keep planning","kind":"reject_once"}]}},{"itemId":"e","type":"tool_call","kind":"execute","title":"ls","status":"completed","plan":"ignored","hasDetail":false}]}]}"""
  val frame=JSONObject().put("type","session").put("sessionId","s").put("session",body)
  val items=(RuntimeProtocol.event(frame) as RuntimeEvent.SessionUpdated).snapshot.messages.single().items
  assertEquals(TurnItem.ProposedPlan("p","1. Draft",streaming=true),items[0])
  val approval=items[1] as TurnItem.Tool
  assertEquals("1. Build",approval.plan)
  assertTrue(approval.awaitingPermission)
  assertEquals(ToolPermission("r",true,listOf(PermissionOption("yes","Yes","allow_once"),PermissionOption("no","No, keep planning","reject_once"))),approval.permission)
  assertEquals("Only a plan approval carries a plan",null,(items[2] as TurnItem.Tool).plan)
  val chosen=RuntimeProtocol.detail(JSONObject().put("blocks",org.json.JSONArray()).put("outcome",JSONObject().put("outcome","selected").put("optionId","no")))
  assertEquals("no",chosen.chosenOption)
  assertFalse(chosen.withdrawn)
  assertTrue(RuntimeProtocol.detail(JSONObject().put("outcome",JSONObject().put("outcome","cancelled"))).withdrawn)
 }
 @Test fun recoveredInputsStayUnconfirmedAndDoNotDuplicateOwnerHistory() {
  val body = """{"v":1,"status":"live","entries":[{"id":"owner","role":"user","finished":true,"items":[{"type":"text","text":"confirmed"}]}],"pendingRoostInputs":[{"id":"owner","items":[{"type":"text","text":"duplicate"}]},{"id":"pending","timestamp":"2026-01-01","userId":"u","inputState":"unknown","items":[{"type":"text","text":"kept"},{"type":"file","file":{"fileName":"proof.txt"}}]}]}"""
  val frame = JSONObject().put("type", "session").put("sessionId", "s").put("session", body)
  val messages = (RuntimeProtocol.event(frame) as RuntimeEvent.SessionUpdated).snapshot.messages
  assertEquals(listOf("owner", "pending"), messages.map { it.id })
  assertEquals("delivery_unknown", messages.last().status)
  assertEquals("proof.txt", messages.last().attachments.single().name)
  assertEquals("kept", messages.last().text)
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
 @Test fun sessionHistoryPageStateIsProjected() {
  val frame=JSONObject().put("type","session").put("sessionId","s").put("session", """{"v":1,"status":"live","entries":[],"historyHasMore":true,"historyLoading":true}""")
  val snapshot=(RuntimeProtocol.event(frame) as RuntimeEvent.SessionUpdated).snapshot
  assertTrue(snapshot.historyHasMore)
  assertTrue(snapshot.historyLoading)
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
 @Test fun browseFilesKeepsSafeEntriesFoldersFirstAndMapsFileOutcomes() {
  val listing = RuntimeProtocol.directory(JSONObject("""{"truncated":true,"entries":[{"name":"b.md","type":"file"},{"name":"src","type":"directory"},{"name":"A.md","type":"file"},{"name":"..","type":"directory"},{"name":"x/y","type":"file"},{"name":"link","type":"symlink"},{"type":"file"}]}"""))
  assertEquals(listOf(DirectoryEntry("src", true), DirectoryEntry("A.md", false), DirectoryEntry("b.md", false)), listing.entries)
  assertTrue(listing.truncated)
  assertThrows(IllegalArgumentException::class.java) { RuntimeProtocol.directory(JSONObject("{}")) }
  assertEquals(FileContent.Text("docs/a.md", "# A\n", 4), RuntimeProtocol.file(JSONObject("""{"status":"ok","path":"docs/a.md","kind":"text","text":"# A\n","bytes":4}"""), "docs/a.md"))
  assertEquals(FileContent.Binary("logo.png", 8), RuntimeProtocol.file(JSONObject("""{"status":"ok","path":"logo.png","kind":"binary","base64":"iVBORw0KGgo=","bytes":8}"""), "logo.png"))
  assertEquals(FileContent.Failed("big.md", "too_large"), RuntimeProtocol.file(JSONObject("""{"status":"error","path":"big.md","code":"too_large"}"""), "big.md"))
  assertEquals(FileContent.Failed("odd.md", "read_failed"), RuntimeProtocol.file(JSONObject("""{"status":"ok","kind":"text"}"""), "odd.md"))
 }
 @Test fun previewsCrossTheNativeBoundary() {
  val token = RuntimeProtocol.event(JSONObject().put("type", "previewToken").put("requestId", "r").put("intent", "{\"workspaceId\":\"w\"}"))
  assertEquals(RuntimeEvent.PreviewTokenRequested("r", "{\"workspaceId\":\"w\"}"), token)
  val session = RuntimeProtocol.event(JSONObject().put("type", "session").put("sessionId", "s")
   .put("session", """{"v":1,"status":"live","entries":[],"preview":{"label":"localhost:5173","active":true}}""")) as RuntimeEvent.SessionUpdated
  assertEquals(BrowserPreview("localhost:5173", true), session.snapshot.preview)
  val catalog = RuntimeProtocol.event(JSONObject().put("type", "catalog").put("revision", 1).put("catalog",
   """{"projects":[],"sessions":[{"id":"s","machineId":"m","projectId":"p","title":"t","status":"idle","archived":false,"pinned":false,"createdAt":"2026-01-01T00:00:00Z","androidEmulatorPreviewRequestId":"req"}],"machineIds":["m","n"],"machineSimulators":{"m":"upgrade-required","n":"bogus"},"machineEmulators":{"n":"available"}}""")) as RuntimeEvent.CatalogUpdated
  assertEquals(mapOf("m" to "upgrade-required"), catalog.snapshot.machineSimulators)
  assertEquals(mapOf("n" to "available"), catalog.snapshot.machineEmulators)
  assertEquals("req", catalog.snapshot.sessions.single().androidEmulatorPreviewRequestId)
  val reply = PreviewJson.reply(DevicePlatform.ANDROID, JSONObject("""{"success":true,"devices":[{"id":"Pixel_8","name":"Pixel 8","runtime":"API 35","deviceType":"phone","state":"Shutdown","available":true,"occupancy":"other-session"},{"udid":"ios-only"}],
   "preview":{"operationId":"op","id":"Pixel_8","phase":"ready","transport":"remote","viewerUrl":"https://a-b.trycloudflare.com/v"}}"""))
  assertEquals(listOf("Pixel_8"), reply.devices?.map { it.id })
  assertEquals("other-session", reply.devices?.single()?.occupancy)
  assertEquals("ready", reply.preview?.phase)
  assertEquals(JSONObject().put("action", "start").put("udid", "U").toString(), PreviewJson.command(DevicePlatform.IOS, DeviceCommand.Start("U", "clear")).toString())
  assertEquals("saver", PreviewJson.command(DevicePlatform.ANDROID, DeviceCommand.Start("Pixel_8", "saver")).getString("quality"))
 }
}
