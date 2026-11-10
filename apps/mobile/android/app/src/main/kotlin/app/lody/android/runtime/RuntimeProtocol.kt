package app.lody.android.runtime

import org.json.JSONArray
import org.json.JSONObject

/** Decode the shared runtime's projection, never carry org.json into feature code. */
internal object RuntimeProtocol {
    fun capabilities(message: JSONObject): Set<String> {
        require(message.get("protocol") == 2)
        val result = strings(message.getJSONArray("capabilities")).toSet()
        require(result.containsAll(setOf("ping", "setActive", "probeSchema")))
        require(result.size <= 64 && result.all { it.length <= 80 })
        return result
    }
    fun event(message: JSONObject): RuntimeEvent? = when (message.getString("type")) {
        "agentProvidersChanged" -> RuntimeEvent.ProvidersChanged(message.getString("machineId"))
        "agentProviderOperationProgress" -> RuntimeEvent.ProviderProgress(message.getString("machineId"), message.getString("id"), message.getString("status"), (message.opt("percent") as? Number)?.toFloat()?.takeIf { it.isFinite() }?.coerceIn(0f, 100f))
        "machinePresence" -> RuntimeEvent.CreationChanged(message.optString("presence"))
        "creationOptionsChanged" -> RuntimeEvent.CreationChanged()
        "session" -> {
            val envelope = JSONObject(message.getString("session"))
            require(envelope.getInt("v") == 1)
            val entries = envelope.getJSONArray("entries").objects().mapNotNull { entry ->
                val role = entry.text("role")
                if (role !in setOf("user", "assistant", "system")) return@mapNotNull null
                val rawItems = entry.getJSONArray("items").objects()
                if (role == "system") {
                    val operations = rawItems.flatMap(OperationEvents::parse)
                    return@mapNotNull if (operations.isEmpty()) null else SessionMessage(
                        id = entry.text("id"), role = role, text = "", streaming = false, operations = operations,
                    )
                }
                val text = rawItems.mapNotNull { item ->
                    when (item.optString("type")) {
                        "text" -> item.optString("text")
                        "proposed_plan" -> item.optString("markdown").takeUnless { item.optString("status") == "cleared" }
                        else -> null
                    }
                }.joinToString("\n\n")
                var referenceOffset = 0
                val references = rawItems.filter { it.optString("type") == "text" }.flatMap { item ->
                    val value = item.optString("text")
                    val ranges = item.optJSONArray("references")?.objects().orEmpty().mapNotNull { span ->
                        val start = span.optInt("start", -1); val end = span.optInt("end", -1)
                        if (start < 0 || end <= start || end > value.length) null else MessageReference(start + referenceOffset, end + referenceOffset)
                    }
                    referenceOffset += value.length + 2
                    ranges
                }
                val items = rawItems.mapNotNull(::turnItem)
                val files = entry.optJSONArray("fileDiffs")?.objects()?.mapNotNull { file ->
                    val path = file.optString("path").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    FileChange(path, file.optInt("add"), file.optInt("del"))
                }.orEmpty()
                val attachments = if (role != "user") emptyList() else rawItems.flatMap { item ->
                    when (item.optString("type")) {
                        "image" -> listOfNotNull(item.optJSONObject("image"))
                        "image_group" -> item.optJSONArray("images")?.objects().orEmpty()
                        else -> emptyList()
                    }.map { MessageAttachment(it.optString("fileName").ifBlank { "image" }, image = true) } +
                        listOfNotNull(item.optJSONObject("file")?.takeIf { item.optString("type") == "file" }?.let { MessageAttachment(it.optString("fileName").ifBlank { "file" }, image = false) })
                }
                // An assistant turn may so far be only steps; a user turn needs its text or attachments.
                if (text.isBlank() && (if (role == "user") attachments.isEmpty() else items.isEmpty() && files.isEmpty())) null else SessionMessage(
                    id = entry.text("id"),
                    role = role,
                    text = text,
                    references = references,
                    streaming = role == "assistant" && !entry.optBoolean("finished", true),
                    timestamp = (entry.opt("timestamp") as? String)?.takeIf { it.isNotBlank() },
                    status = entry.optString("status"),
                    userId = (entry.opt("userId") as? String)?.takeIf { it.isNotBlank() },
                    startedAt = (entry.opt("startedAt") as? Number)?.toLong(),
                    endedAt = (entry.opt("endedAt") as? Number)?.toLong(),
                    permissionWaitMs = (entry.opt("permissionWaitMs") as? Number)?.toLong()?.coerceAtLeast(0) ?: 0,
                    metadata = buildMap {
                        entry.optJSONObject("modelInfo")?.let { info ->
                            listOf("modelId", "name", "thoughtLevel").forEach { key -> (info.opt(key) as? String)?.takeIf { it.isNotBlank() }?.let { put(key, it) } }
                        }
                        entry.optJSONObject("inputConfig")?.let { info -> (info.opt("modeId") as? String)?.let { put("modeId", it) } }
                        entry.optJSONObject("tokenUsage")?.let { usage ->
                            listOf("inputTokens", "outputTokens", "reasoningOutputTokens", "cacheReadInputTokens", "cacheCreationInputTokens").forEach { key ->
                                (usage.opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it % 1 == 0.0 }?.let { put(key, it.toLong().toString()) }
                            }
                        }
                    },
                    model = entry.optJSONObject("modelInfo")?.let { info -> info.optString("name").ifBlank { info.optString("modelId") }.ifBlank { null } },
                    items = if (role == "assistant") items else emptyList(),
                    files = if (role == "assistant") files else emptyList(),
                    attachments = attachments,
                )
            }
            val composer = envelope.optJSONObject("composer")?.let { value ->
                fun field(key: String) = (value.opt(key) as? String)?.takeIf { it.isNotBlank() }
                val options = value.optJSONObject("configOptionValues")?.let { values ->
                    values.keys().asSequence().mapNotNull { key -> (values.get(key) as? String ?: values.get(key) as? Boolean)?.let { key to it } }.toMap()
                }.orEmpty()
                RunChoice(
                    field("modelId"), field("modeId"), field("effort"), options,
                    agentRoleId = field("agentRoleId"), roleKnown = value.has("agentRoleId"),
                )
            }
            RuntimeEvent.SessionUpdated(SessionSnapshot(message.text("sessionId"), envelope.text("status"), entries, composer, SessionUsageJson.parse(envelope.optJSONObject("usage"))))
        }
        "catalog" -> {
            val catalog = JSONObject(message.get("catalog") as String)
            val projects = catalog.getJSONArray("projects").objects().map {
                CatalogJson.project(CatalogProject(it.text("id"), it.text("machineId"), it.text("name"), it.text("rootPath")), it)
            }
            val sessions = catalog.getJSONArray("sessions").objects().map {
                CatalogJson.session(CatalogSession(it.text("id"), it.text("machineId"), it.text("projectId"), it.text("title"), it.text("status"), it.get("archived") as Boolean, it.get("pinned") as Boolean, it.text("createdAt")), it)
            }
            RuntimeEvent.CatalogUpdated(CatalogSnapshot(message.nonnegative("revision"), projects, sessions, strings(catalog.getJSONArray("machineIds")), CatalogJson.machineNames(catalog), CatalogJson.machineOs(catalog), ProviderUsageJson.parse(catalog)))
        }
        "synced" -> {
            val count = message.nonnegative("streams"); require(count <= Int.MAX_VALUE)
            RuntimeEvent.Synced(message.nonnegative("revision"), count.toInt())
        }
        "syncError" -> {
            val reason = message.optString("reason")
            RuntimeEvent.SyncFailed(if (reason in setOf("catalog_limit", "stream_closed", "stalled_cursor", "network_or_auth")) reason else "sync_failed")
        }
        "networkStatus" -> RuntimeEvent.SyncFailed(if (message.optString("status") == "authorization_required") "grant_expired" else "network_unavailable")
        "grant" -> RuntimeEvent.GrantRequested
        else -> null
    }
    fun schema(message: JSONObject): RuntimeResult.Schema {
        val trials = message.getJSONObject("creationOptionsTrial")
        return RuntimeResult.Schema(message.getJSONObject("machines").keys().asSequence().toSet(), trials.keys().asSequence().associateWith { trials.text(it) })
    }
    /** Upstream `turnDiff`: `ok` with both sides, or `unavailable` with a reason. */
    fun diff(json: JSONObject): FileDiff {
        // A missing side (file added or deleted) is empty text; binary or oversized is no text.
        fun side(key: String): String? {
            val side = json.optJSONObject(key) ?: return null
            return when (side.optString("kind")) {
                "text" -> side.optString("text")
                "missing" -> ""
                else -> null
            }
        }
        val ok = json.optString("status") == "ok"
        return FileDiff(
            path = json.optString("path"),
            oldText = if (ok) side("old") else null,
            newText = if (ok) side("new") else null,
            added = (json.opt("add") as? Number)?.toInt(),
            removed = (json.opt("del") as? Number)?.toInt(),
            unavailable = if (ok) null else json.optString("reason").ifBlank { "unavailable" },
        )
    }

    /** Upstream `itemDetail` blocks (`terminal_command` / `terminal_output` / `diff` / `text` / …), leniently. */
    fun detail(json: JSONObject): StepDetail {
        val blocks = json.optJSONArray("blocks")?.objects().orEmpty().mapNotNull { block ->
            val command = block.optString("command").takeIf { it.isNotBlank() }?.let { text ->
                val args = block.optJSONArray("args")?.let { array -> (0 until array.length()).map { array.optString(it) } }.orEmpty()
                (listOf(text) + args).joinToString(" ")
            }
            when {
                block.optString("type") == "diff" -> StepBlock.Diff(block.optString("path"), block.optString("oldText"), block.optString("newText"))
                command != null -> StepBlock.Command(command, block.optString("cwd").ifBlank { null })
                block.has("output") -> StepBlock.Output(
                    block.optString("output"),
                    block.optJSONObject("exitStatus")?.let { (it.opt("exitCode") as? Number)?.toInt() },
                )
                else -> (block.optString("text").ifBlank { block.optJSONObject("content")?.optString("text").orEmpty() })
                    .takeIf { it.isNotBlank() }?.let { StepBlock.Text(it) }
            }
        }
        return StepDetail(blocks, json.optBoolean("truncated"))
    }

    /** One upstream `ItemSummary`, leniently: unknown types and malformed fields are dropped. */
    private fun turnItem(item: JSONObject): TurnItem? {
        val id = item.optString("itemId").ifEmpty { return null }
        return when (item.optString("type")) {
            "text" -> item.optString("text").takeIf { it.isNotBlank() }?.let { TurnItem.Text(id, it) }
            "thought" -> item.optString("text").takeIf { it.isNotBlank() }?.let { TurnItem.Thought(id, it) }
            "tool_call" -> TurnItem.Tool(
                id,
                kind = item.optString("kind"),
                title = item.optString("title"),
                status = item.optString("status"),
                path = item.optString("path").ifEmpty { null },
                added = (item.opt("added") as? Number)?.toInt(),
                removed = (item.opt("removed") as? Number)?.toInt(),
                awaitingPermission = item.optJSONObject("permission")?.optBoolean("pending") == true,
                hasDetail = item.optBoolean("hasDetail"),
            )
            "proposed_plan" -> item.optString("markdown").takeIf { it.isNotBlank() && item.optString("status") != "cleared" }
                ?.let { TurnItem.ProposedPlan(id, it) }
            "plan" -> item.optJSONArray("entries")?.objects()?.map { it.optString("content") to it.optString("status") }
                ?.takeIf { it.isNotEmpty() }?.let { TurnItem.Checklist(id, it) }
            "subagent_task" -> {
                if (item.optBoolean("skipTranscript")) return null
                val run = item.optJSONObject("run")
                val steps = run?.optJSONArray("items")?.objects().orEmpty().mapNotNull(::turnItem)
                // The run's own state can say cancelled or unknown; the legacy status cannot (web).
                val state = run?.optString("state")?.takeIf { it.isNotBlank() } ?: when (item.optString("status")) {
                    "in_progress" -> "running"
                    "" -> "pending"
                    else -> item.optString("status")
                }
                val latest = when (val last = steps.lastOrNull()) {
                    is TurnItem.Tool -> last.title
                    is TurnItem.Text -> last.text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty()
                    is TurnItem.Thought -> ""
                    else -> ""
                }.ifBlank { item.optString("lastToolName") }
                TurnItem.Task(
                    id,
                    actor = item.optString("actor"),
                    description = item.optString("description"),
                    state = state,
                    latest = latest.trim(),
                    result = item.optString("summary").ifBlank { item.optString("error") }.trim(),
                    background = item.optBoolean("isBackgrounded"),
                    steps = steps,
                    group = if (item.optString("group") == "tasks") "tasks" else "subagents",
                )
            }
            "system_notice" -> {
                val name = item.optString("name")
                val message = item.optJSONObject("meta")?.optString("message").orEmpty()
                // Agent warnings and unnamed placeholders are not part of the conversation (iOS too).
                if (name.isEmpty() || name == "agent_warning") null
                else TurnItem.Notice(id, message.ifBlank { name }, failure = name == "chat_failed")
            }
            else -> null
        }
    }
    private fun JSONObject.text(key: String) = get(key) as String
    private fun JSONObject.nonnegative(key: String): Long {
        val value = get(key)
        require(value is Int || value is Long)
        return (value as Number).toLong().also { require(it >= 0) }
    }
    private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
    private fun strings(array: JSONArray) = (0 until array.length()).map { array.get(it) as String }
}
