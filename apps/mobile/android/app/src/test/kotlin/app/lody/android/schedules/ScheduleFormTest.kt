package app.lody.android.schedules

import app.lody.android.runtime.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId

class ScheduleFormTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private fun detail(rule: String, extra: String = "") = ScheduleJson.detail(JSONObject("""
        {"item":{"scheduleId":"s1","title":"Nightly","ownerId":"u","isOwner":true,"machineId":"m","machineSupported":true,
          "agentConfigId":"a","enabled":true,"scheduledMessage":false,"rule":$rule,"destination":"own_session",
          "state":{"group":"running","kind":"runsAt","at":1700000000000},"createdAt":1,"updatedAt":2$extra},
         "prompt":"Review","project":{"kind":"local","localProjectId":"p","useWorktree":true,"name":"Repo"}}
    """.trimIndent()))

    @Test fun anUntouchedRuleIsSavedExactlyAsReceivedEvenWhenUnsupported() {
        val received = """{"kind":"unsupported","summary":"*/7 * * * *","timeZone":"Asia/Tokyo"}"""
        val form = ScheduleForms.of(detail(received), 0, zone)
        assertEquals(Frequency.Unsupported, form.frequency)
        val draft = ScheduleForms.draft(form, "Europe/Berlin", null)!!
        assertTrue(JSONObject(received).similar(ScheduleJson.encodeRule(draft.rule)))
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
        assertTrue(json.toString(), expected.similar(json))
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
