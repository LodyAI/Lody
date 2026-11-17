package app.lody.android.schedules

import app.lody.android.runtime.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent

@OptIn(ExperimentalCoroutinesApi::class)
class ScheduleFormTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private fun detail(rule: String, extra: String = "") = ScheduleJson.detail(JSONObject("""
        {"item":{"scheduleId":"s1","title":"Nightly","ownerId":"u","isOwner":true,"machineId":"m","machineSupported":true,
          "agentConfigId":"a","enabled":true,"scheduledMessage":false,"rule":$rule,"destination":"own_session",
          "state":{"group":"running","kind":"runsAt","at":1700000000000},"createdAt":1,"updatedAt":2$extra},
         "prompt":"Review","project":{"kind":"local","localProjectId":"p","useWorktree":true,"name":"Repo"}}
    """.trimIndent()))

    private val scope = RuntimeScope("u", "w")
    private fun schedules() = ScheduleList(listOf(detail("""{"kind":"daily","hour":9,"minute":0}""").item), "UTC", mapOf("m" to "Europe/Berlin"), setOf("m"))
    private class Store(var saved: ScheduleList?) : ScheduleStore {
        override suspend fun readSchedules(scope: RuntimeScope) = saved
        override suspend fun writeSchedules(scope: RuntimeScope, value: ScheduleList) { saved = value }
    }
    private class Service(override val displayCache: ScheduleDisplayCache? = null) : ScheduleService {
        var read: suspend () -> ScheduleList = { error("missing fixture") }
        var write: suspend () -> String = { "s1" }
        override suspend fun list(scope: RuntimeScope) = read()
        override suspend fun detail(scope: RuntimeScope, scheduleId: String): ScheduleDetail = error("unused")
        override suspend fun command(scope: RuntimeScope, request: ScheduleCommandRequest) = write()
    }

    @Test fun coldStartShowsCacheBeforeLiveReadAndRetainsItOnFailure() = runTest {
        val saved = schedules()
        val store = Store(saved)
        val service = Service(ScheduleDisplayCache(store))
        val gate = CompletableDeferred<ScheduleList>()
        service.read = { gate.await() }
        val state = SchedulesState(service, scope)
        val refresh = launch { state.refresh() }
        runCurrent()
        assertEquals(saved, state.list)
        assertTrue(state.loading)
        gate.completeExceptionally(ScheduleFailure("offline")); refresh.join()
        assertEquals(saved, state.list)
        assertEquals("offline", state.failure)
        val live = saved.copy(items = emptyList())
        service.read = { live }; state.refresh()
        assertEquals(live, state.list)
        assertEquals(live, store.saved)
        assertNull(state.failure)
    }

    @Test fun overlappingFirstRefreshesStillRestoreBeforeTheirLiveReadFails() = runTest {
        val saved = schedules()
        val disk = CompletableDeferred<Unit>()
        val cache = ScheduleDisplayCache(object : ScheduleStore {
            override suspend fun readSchedules(scope: RuntimeScope): ScheduleList { disk.await(); return saved }
            override suspend fun writeSchedules(scope: RuntimeScope, value: ScheduleList) = Unit
        })
        val service = Service(cache).apply { read = { throw ScheduleFailure("offline") } }
        val state = SchedulesState(service, scope)
        val first = launch { state.refresh() }; runCurrent()
        val second = launch { state.refresh() }; runCurrent()
        disk.complete(Unit); first.join(); second.join()
        assertEquals(saved, state.list)
        assertEquals("offline", state.failure)
        assertFalse(state.loading)
    }

    @Test fun pendingCommandsKeepRowsVisibleAndRejectDuplicateIntents() = runTest {
        val saved = schedules()
        val service = Service().apply { read = { saved } }
        val state = SchedulesState(service, scope); state.refresh()
        val gate = CompletableDeferred<String>()
        service.write = { gate.await() }
        val command = launch { state.command(ScheduleCommandRequest("pause", "s1", "first")) }; runCurrent()
        service.read = { saved.copy(items = emptyList()) }
        state.refresh()
        assertEquals("s1", state.list!!.items.single().scheduleId)
        assertFalse(state.list!!.items.single().enabled)
        val duplicate = runCatching { state.command(ScheduleCommandRequest("resume", "s1", "second")) }.exceptionOrNull()
        assertEquals("schedule_conflict", (duplicate as ScheduleFailure).code)
        gate.complete("s1"); command.join()
        assertTrue(state.list!!.items.isEmpty())
    }

    @Test fun pauseIsImmediateAndOlderReadsCannotUndoItOrPersistIt() = runTest {
        val saved = schedules()
        val store = Store(saved)
        val service = Service(ScheduleDisplayCache(store)).apply { read = { saved } }
        val state = SchedulesState(service, scope); state.refresh()
        val old = CompletableDeferred<ScheduleList>()
        service.read = { old.await() }
        val refresh = launch { state.refresh() }; runCurrent()
        val write = CompletableDeferred<String>()
        service.write = { write.await() }
        val command = launch { state.command(ScheduleCommandRequest("pause", "s1", "request")) }; runCurrent()
        assertFalse(state.list!!.items.single().enabled)
        assertEquals("paused", state.list!!.items.single().state.group)
        assertTrue(state.isPending("s1"))
        old.complete(saved); refresh.join()
        assertFalse(state.list!!.items.single().enabled)
        assertEquals(saved, store.saved)
        val confirmed = state.list!!
        service.read = { confirmed }
        write.complete("s1"); command.join()
        assertFalse(state.isPending("s1"))
        assertEquals(confirmed, store.saved)
    }

    @Test fun failedAndUnknownResumeRollBackWhileRefreshFailsWithoutReplaying() = runTest {
        for (code in listOf("schedule_not_owner", ScheduleCodes.WRITE_UNKNOWN)) {
            val saved = schedules().let { it.copy(items = it.items.map { row -> row.copy(enabled = false, state = ScheduleState("paused", "paused")) }) }
            val service = Service().apply { read = { saved } }
            val state = SchedulesState(service, scope); state.refresh()
            val gate = CompletableDeferred<String>()
            service.write = { gate.await() }
            service.read = { throw ScheduleFailure("offline") }
            val command = async { runCatching { state.command(ScheduleCommandRequest("resume", "s1", "request")) } }
            runCurrent()
            assertTrue(state.list!!.items.single().enabled)
            assertEquals("running", state.list!!.items.single().state.group)
            gate.completeExceptionally(ScheduleFailure(code))
            assertEquals(code, (command.await().exceptionOrNull() as ScheduleFailure).code)
            assertEquals(saved, state.list)
            assertFalse(state.isPending("s1"))
        }
    }

    @Test fun serializedDiskWritesLeaveTheNewestAcceptedListOnDisk() = runTest {
        val old = schedules()
        val latest = old.copy(items = emptyList())
        val disk = CompletableDeferred<Unit>()
        var persisted: ScheduleList? = null
        val cache = ScheduleDisplayCache(object : ScheduleStore {
            override suspend fun readSchedules(scope: RuntimeScope): ScheduleList? = null
            override suspend fun writeSchedules(scope: RuntimeScope, value: ScheduleList) {
                if (value == old) disk.await()
                persisted = value
            }
        })
        val service = Service(cache).apply { read = { old } }
        val state = SchedulesState(service, scope)
        val first = launch { state.refresh() }; runCurrent()
        service.read = { latest }
        val second = launch { state.refresh() }; runCurrent()
        assertEquals(latest, state.list)
        disk.complete(Unit); first.join(); second.join()
        assertEquals(latest, persisted)
        assertFalse(state.loading)
    }

    @Test fun accountRetirementRejectsLateReadAndDiskRepopulation() = runTest {
        val store = Store(schedules())
        val cache = ScheduleDisplayCache(store)
        val service = Service(cache)
        val gate = CompletableDeferred<ScheduleList>()
        service.read = { gate.await() }
        val state = SchedulesState(service, scope)
        val refresh = launch { state.refresh() }; runCurrent()
        cache.invalidate(); store.saved = null
        gate.complete(schedules().copy(items = emptyList())); refresh.join()
        assertNull(store.saved)
        assertEquals(schedules(), state.list)
        cache.write(scope, 0, schedules())
        assertNull(store.saved)
        val failure = runCatching { state.command(ScheduleCommandRequest("pause", "s1", "request")) }.exceptionOrNull()
        assertEquals("workspace_changed", (failure as ScheduleFailure).code)
    }

    @Test fun anUntouchedRuleIsSavedExactlyAsReceivedEvenWhenUnsupported() {
        val received = """{"kind":"unsupported","summary":"*/7 * * * *","timeZone":"Asia/Tokyo"}"""
        val form = ScheduleForms.of(detail(received), 0, zone)
        assertEquals(Frequency.Unsupported, form.frequency)
        val draft = ScheduleForms.draft(form, "Europe/Berlin", null)!!
        assertEquals(ScheduleJson.rule(JSONObject(received)), ScheduleJson.rule(ScheduleJson.encodeRule(draft.rule)))
        // A replaced rule is authored in the computer's zone.
        val replaced = form.editRule { copy(frequency = Frequency.Weekdays, hour = 7, minute = 30) }
        assertEquals(ScheduleRule("weekdays", hour = 7, minute = 30, timeZone = "Europe/Berlin"), ScheduleForms.draft(replaced, "Europe/Berlin", null)!!.rule)
    }

    @Test fun localProjectsRoundTripThroughTheCatalogIdAndKeepTheirWorktreeChoice() {
        val form = ScheduleForms.of(detail("""{"kind":"daily","hour":9,"minute":0,"timeZone":"UTC"}"""), 0, zone)
        assertEquals("m:local:p", form.projectId)
        val project = ScheduleForms.draft(form, "UTC", null)!!.project!!
        assertEquals(ScheduleProject("local", localProjectId = "p", useWorktree = true), project)
        assertEquals("own_session", ScheduleForms.draft(form, "UTC", null)!!.destination)
    }

    @Test fun saveNeedsNamePromptComputerAgentAndACompleteRule() {
        val ready = ScheduleForm(title = "T", prompt = "P", machineId = "m", agentConfigId = "a")
        assertNotNull(ScheduleForms.draft(ready, "UTC", null))
        for (missing in listOf(ready.copy(title = " "), ready.copy(prompt = ""), ready.copy(machineId = null), ready.copy(agentConfigId = null),
            ready.copy(frequency = Frequency.Weekly, weekdays = emptySet()), ready.copy(frequency = Frequency.Monthly, days = emptySet()),
            ready.copy(projectId = "github:o/r", branch = " "), ready.copy(destination = ScheduleForm.EXISTING_SESSION)))
            assertNull(missing.toString(), ScheduleForms.draft(missing, "UTC", null))
        val github = ScheduleForms.draft(ready.copy(projectId = "github:o/r", branch = "main"), "UTC", null)!!
        assertEquals(ScheduleProject("github", repoFullName = "o/r", branch = "main"), github.project)
    }

    @Test fun onlyTheSameAttemptReusesItsRequestIdAfterAnUnknownOutcome() {
        var n = 0
        val ids = { "r${++n}" }
        val draft = ScheduleForms.draft(ScheduleForm(title = "T", prompt = "P", machineId = "m", agentConfigId = "a"), "UTC", null)
        val first = ScheduleForms.request("create", "s1", draft, null, ids)
        assertEquals("r1", first.requestId)
        assertEquals(first, ScheduleForms.request("create", "s1", draft, first, ids))
        assertEquals("r2", ScheduleForms.request("create", "s1", draft!!.copy(title = "U"), first, ids).requestId)
        assertEquals("r3", ScheduleForms.request("pause", "s1", null, first, ids).requestId)
        assertTrue(ScheduleForms.newId().matches(Regex("[0-9a-f-]{36}")))
    }

    @Test fun readOnlyScheduleRowsOfferOnlyWhatTheirOwnerMay() {
        val item = detail("""{"kind":"manual"}""").item
        assertEquals(listOf("run", "delete"), rowActions(item))
        assertEquals(listOf("delete"), rowActions(item.copy(machineSupported = false)))
        assertEquals(emptyList<String>(), rowActions(item.copy(isOwner = false)))
        assertEquals(listOf("delete"), rowActions(item.copy(scheduledMessage = true)))
        val timed = item.copy(rule = ScheduleRule("daily", hour = 9, minute = 0))
        assertEquals(listOf("pause", "delete"), rowActions(timed))
        assertEquals(listOf("delete"), rowActions(timed.copy(enabled = false, machineSupported = false)))
        assertFalse(ScheduleForms.editable(item.copy(destination = ScheduleForm.EXISTING_SESSION)))
        assertFalse(ScheduleForms.editable(item.copy(scheduledMessage = true)))
    }

    @Test fun commandsSerializeTheContractShapeWithoutDisplayFields() {
        val draft = ScheduleDraft("T", "P", "m", "a", modelId = "gpt", project = ScheduleProject("github", repoFullName = "o/r", branch = "main", name = "R"), destination = "new_session", rule = ScheduleRule("once", at = 1700000000123))
        val json = ScheduleJson.command(ScheduleCommandRequest("edit", "s1", "r1", draft))
        val expected = JSONObject("""{"action":"edit","scheduleId":"s1","requestId":"r1","draft":{"title":"T","prompt":"P","machineId":"m","agentConfigId":"a","modelId":"gpt","project":{"kind":"github","repoFullName":"o/r","branch":"main"},"destination":"new_session","rule":{"kind":"once","at":1700000000123}}}""")
        assertEquals(expected.toString(), json.toString())
        assertFalse(ScheduleJson.command(ScheduleCommandRequest("pause", "s1", "r2")).has("draft"))
    }

    @Test fun inBandFailuresBecomeBusinessFaultsWithTheRuntimeCode() {
        val error = assertThrows(app.lody.android.runtime.RuntimeException::class.java) { ScheduleJson.checked(JSONObject("""{"error":"schedule_not_owner"}""")) }
        assertEquals(RuntimeFault("schedule_not_owner", RuntimeErrorCategory.BUSINESS), error.fault)
        val list = ScheduleJson.list(JSONObject("""{"items":[],"deviceTimeZone":"Europe/Paris","machineTimeZones":{"m":"Asia/Tokyo"}}"""))
        assertEquals("Asia/Tokyo", list.timeZone("m"))
        assertEquals("Europe/Paris", list.timeZone("other"))
    }
}
