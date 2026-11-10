package app.lody.android.runtime

import org.json.JSONArray
import org.json.JSONObject

/** JSON for the schedule commands; the UI only sees the typed models. */
internal object ScheduleJson {
    private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }
    private fun JSONObject.text(key: String): String? = if (has(key) && !isNull(key)) optString(key).ifEmpty { null } else null
    private fun JSONObject.int(key: String): Int? = if (has(key) && !isNull(key)) optInt(key) else null
    private fun JSONObject.long(key: String): Long? = if (has(key) && !isNull(key)) optDouble(key).toLong() else null
    private fun JSONObject.ints(key: String): List<Int>? = optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getInt(it) } }

    /** A bridge reply carrying `{error}` becomes a business fault with that code. */
    fun checked(value: Any?): JSONObject {
        val json = value as? JSONObject ?: throw RuntimeException(RuntimeFault("invalid_schedule_reply", RuntimeErrorCategory.PROTOCOL))
        json.text("error")?.let { throw RuntimeException(RuntimeFault(it, RuntimeErrorCategory.BUSINESS)) }
        return json
    }

    fun rule(json: JSONObject) = ScheduleRule(
        kind = json.getString("kind"),
        every = json.int("every"), hour = json.int("hour"), minute = json.int("minute"),
        weekdays = json.ints("weekdays"), days = json.ints("days"),
        at = json.long("at"), timeZone = json.text("timeZone"), summary = json.text("summary"),
    )

    fun encodeRule(rule: ScheduleRule): JSONObject = JSONObject().apply {
        put("kind", rule.kind)
        rule.every?.let { put("every", it) }
        rule.hour?.let { put("hour", it) }
        rule.minute?.let { put("minute", it) }
        rule.weekdays?.let { put("weekdays", JSONArray(it)) }
        rule.days?.let { put("days", JSONArray(it)) }
        rule.at?.let { put("at", it) }
        rule.timeZone?.let { put("timeZone", it) }
        rule.summary?.let { put("summary", it) }
    }

    private fun project(json: JSONObject) = ScheduleProject(
        json.getString("kind"), json.text("localProjectId"), json.text("repoFullName"), json.text("branch"),
        if (json.has("useWorktree")) json.optBoolean("useWorktree") else null, json.text("name"),
    )

    /** The display [ScheduleProject.name] is the runtime's; it is never sent back. */
    private fun encodeProject(project: ScheduleProject): JSONObject = JSONObject().apply {
        put("kind", project.kind)
        project.localProjectId?.let { put("localProjectId", it) }
        project.repoFullName?.let { put("repoFullName", it) }
        project.branch?.let { put("branch", it) }
        project.useWorktree?.let { put("useWorktree", it) }
    }

    fun item(json: JSONObject): ScheduleItem {
        val state = json.getJSONObject("state")
        return ScheduleItem(
            scheduleId = json.getString("scheduleId"),
            title = json.optString("title"),
            ownerId = json.optString("ownerId"),
            isOwner = json.optBoolean("isOwner"),
            machineId = json.getString("machineId"),
            machineName = json.text("machineName"),
            machineSupported = json.optBoolean("machineSupported"),
            agentConfigId = json.optString("agentConfigId"),
            agentName = json.text("agentName"),
            agentType = json.text("agentType"),
            enabled = json.optBoolean("enabled"),
            scheduledMessage = json.optBoolean("scheduledMessage"),
            rule = rule(json.getJSONObject("rule")),
            destination = json.optString("destination", "new_session"),
            destinationSessionId = json.text("destinationSessionId"),
            projectKind = json.text("projectKind"),
            projectKey = json.text("projectKey"),
            projectName = json.text("projectName"),
            state = ScheduleState(state.optString("group", "running"), state.optString("kind", "notScheduled"), state.long("at"), state.text("blockedCode")),
            lastRunAt = json.long("lastRunAt"),
            lastSessionId = json.text("lastSessionId"),
            createdAt = json.long("createdAt") ?: 0L,
            updatedAt = json.long("updatedAt") ?: 0L,
        )
    }

    fun list(json: JSONObject): ScheduleList {
        val zones = json.optJSONObject("machineTimeZones") ?: JSONObject()
        return ScheduleList(
            json.optJSONArray("items").objects().map(::item),
            json.optString("deviceTimeZone").ifEmpty { "UTC" },
            zones.keys().asSequence().associateWith { zones.getString(it) },
            json.optJSONArray("ownedMachineIds")?.let { owned -> (0 until owned.length()).map(owned::getString).toSet() }.orEmpty(),
        )
    }

    fun encodeList(value: ScheduleList): JSONObject = JSONObject()
        .put("items", JSONArray(value.items.map { item -> JSONObject().apply {
            put("scheduleId", item.scheduleId)
            put("title", item.title)
            put("ownerId", item.ownerId)
            put("isOwner", item.isOwner)
            put("machineId", item.machineId)
            put("machineName", item.machineName)
            put("machineSupported", item.machineSupported)
            put("agentConfigId", item.agentConfigId)
            put("agentName", item.agentName)
            put("agentType", item.agentType)
            put("enabled", item.enabled)
            put("scheduledMessage", item.scheduledMessage)
            put("destination", item.destination)
            put("destinationSessionId", item.destinationSessionId)
            put("projectKind", item.projectKind)
            put("projectKey", item.projectKey)
            put("projectName", item.projectName)
            put("lastRunAt", item.lastRunAt)
            put("lastSessionId", item.lastSessionId)
            put("createdAt", item.createdAt)
            put("updatedAt", item.updatedAt)
            put("rule", encodeRule(item.rule))
            put("state", JSONObject().put("group", item.state.group).put("kind", item.state.kind)
                .put("at", item.state.at).put("blockedCode", item.state.blockedCode))
        } }))
        .put("deviceTimeZone", value.deviceTimeZone)
        .put("machineTimeZones", JSONObject(value.machineTimeZones))
        .put("ownedMachineIds", JSONArray(value.ownedMachineIds.toList()))

    fun detail(json: JSONObject) = ScheduleDetail(
        item(json.getJSONObject("item")), json.optString("prompt"), json.text("modelId"), json.text("modeId"),
        json.optJSONObject("project")?.let(::project),
    )

    fun command(request: ScheduleCommandRequest): JSONObject = JSONObject().apply {
        put("action", request.action).put("scheduleId", request.scheduleId).put("requestId", request.requestId)
        request.draft?.let { draft ->
            put("draft", JSONObject().apply {
                put("title", draft.title).put("prompt", draft.prompt)
                put("machineId", draft.machineId).put("agentConfigId", draft.agentConfigId)
                draft.modelId?.let { put("modelId", it) }
                draft.modeId?.let { put("modeId", it) }
                draft.project?.let { put("project", encodeProject(it)) }
                put("destination", draft.destination)
                put("rule", encodeRule(draft.rule))
            })
        }
    }
}
