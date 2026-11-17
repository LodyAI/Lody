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
        "agentProviderRefreshProgress" -> RuntimeEvent.ProviderRefreshProgress(message.getString("machineId"), message.getString("id"),
            message.optString("modelName").ifBlank { message.getString("modelId") }, message.getInt("index"), message.getInt("total"))
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
                    val proposals = rawItems.mapNotNull { ProposalEvents.parse(entry.text("id"), it) }
                    return@mapNotNull if (operations.isEmpty() && proposals.isEmpty()) null else SessionMessage(
                        id = entry.text("id"), role = role, text = "", streaming = false, operations = operations, proposals = proposals,
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
                val attachments = if (role != "user") emptyList() else attachments(rawItems)
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
            // Locally durable inputs are not owner history. Show their uncertainty
            // until the authoritative turn arrives; never turn them into a send.
            val existing = entries.map { it.id }.toSet()
            val pending = envelope.optJSONArray("pendingRoostInputs")?.objects().orEmpty().mapNotNull { entry ->
                val id = entry.optString("id").takeIf { it.isNotBlank() && it !in existing } ?: return@mapNotNull null
                val items = entry.optJSONArray("items")?.objects().orEmpty()
                val text = items.filter { it.optString("type") == "text" }.joinToString("\n\n") { it.optString("text") }
                val attachments = attachments(items)
                if (text.isBlank() && attachments.isEmpty()) null else SessionMessage(
                    id = id, role = "user", text = text, streaming = false, timestamp = (entry.opt("timestamp") as? String),
                    status = when (entry.optString("inputState")) {
                        "unknown" -> "delivery_unknown"
                        "confirmed" -> "pending"
                        else -> "sending"
                    }, userId = (entry.opt("userId") as? String), attachments = attachments,
                    inputRetryable = entry.optBoolean("inputRetryable"),
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
            RuntimeEvent.SessionUpdated(SessionSnapshot(
                id = message.text("sessionId"),
                status = envelope.text("status"),
                messages = entries + pending,
                composer = composer,
                usage = SessionUsageJson.parse(envelope.optJSONObject("usage")),
                preview = PreviewJson.summary(envelope.optJSONObject("preview")),
                historyHasMore = envelope.optBoolean("historyHasMore"),
                historyLoading = envelope.optBoolean("historyLoading"),
                billableTurnCount = (envelope.opt("billableTurnCount") as? Number)?.toInt()?.takeIf { it >= 0 },
            ))
        }
        "catalog" -> {
            val catalog = JSONObject(message.get("catalog") as String)
            val projects = catalog.getJSONArray("projects").objects().map {
                CatalogJson.project(CatalogProject(it.text("id"), it.text("machineId"), it.text("name"), it.text("rootPath")), it)
            }
            val sessions = catalog.getJSONArray("sessions").objects().map {
                CatalogJson.session(CatalogSession(it.text("id"), it.text("machineId"), it.text("projectId"), it.text("title"), it.text("status"), it.get("archived") as Boolean, it.get("pinned") as Boolean, it.text("createdAt")), it)
            }
            RuntimeEvent.CatalogUpdated(CatalogSnapshot(message.nonnegative("revision"), projects, sessions, strings(catalog.getJSONArray("machineIds")), CatalogJson.machineNames(catalog), CatalogJson.machineOs(catalog), ProviderUsageJson.parse(catalog), CatalogJson.machineSimulators(catalog), CatalogJson.machineEmulators(catalog)))
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
        "shortcutCloud" -> RuntimeEvent.ShortcutCloudRequested(message.getString("requestId"), message.getString("operation"), message.getString("args"))
        "previewToken" -> RuntimeEvent.PreviewTokenRequested(message.getString("requestId"), message.getString("intent"))
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

    /** Upstream `listDir`, leniently: malformed entries are dropped, folders first, then by name. */
    fun directory(json: JSONObject): DirectoryListing {
        val array = json.optJSONArray("entries") ?: throw IllegalArgumentException("invalid_directory")
        val entries = (0 until array.length()).mapNotNull { index ->
            val entry = array.optJSONObject(index) ?: return@mapNotNull null
            val name = entry.optString("name")
            val type = entry.optString("type")
            if (name.isBlank() || name == "." || name == ".." || '/' in name || type !in setOf("file", "directory")) null
            else DirectoryEntry(name, type == "directory")
        }.sortedWith(compareBy<DirectoryEntry> { !it.directory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        return DirectoryListing(entries, json.optBoolean("truncated"))
    }

    /** Upstream `readFile`: text, binary (contents not kept), or the computer's error code. */
    fun file(json: JSONObject, requested: String): FileContent {
        val path = json.optString("path").ifBlank { requested }
        val bytes = (json.opt("bytes") as? Number)?.toLong() ?: 0L
        return when {
            json.optString("status") != "ok" -> FileContent.Failed(path, json.optString("code").ifBlank { "read_failed" })
            json.optString("kind") == "text" && json.has("text") -> FileContent.Text(path, json.optString("text"), bytes)
            json.optString("kind") == "binary" -> FileContent.Binary(path, bytes)
            else -> FileContent.Failed(path, "read_failed")
        }
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
        // A settled question's answers; the decision itself travels on the step's summary.
        return StepDetail(blocks, json.optBoolean("truncated"), answers = answers(json.optJSONObject("outcome")))
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
                plan = (item.opt("plan") as? String)?.takeIf { it.isNotBlank() && item.optString("kind") == "switch_mode" },
                permission = item.optJSONObject("permission")?.let(::permission),
            )
            "proposed_plan" -> item.optString("markdown").takeIf { it.isNotBlank() && item.optString("status") != "cleared" }
                ?.let { TurnItem.ProposedPlan(id, it, streaming = item.optString("status") == "delta") }
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
            "image", "image_group" -> {
                val raw = if (item.optString("type") == "image") listOfNotNull(item.optJSONObject("image"))
                else item.optJSONArray("images")?.objects().orEmpty()
                raw.mapNotNull { image ->
                    val imageId = image.optString("id").ifBlank { return@mapNotNull null }
                    fun size(key: String) = (image.opt(key) as? Number)?.toInt()?.takeIf { it > 0 }
                    TurnImage(imageId, image.optString("fileName").ifBlank { "image" }, (image.opt("storageSessionId") as? String)?.takeIf { it.isNotBlank() }, size("width"), size("height"))
                }.takeIf { it.isNotEmpty() }?.let { TurnItem.Images(id, it) }
            }
            "file" -> item.optJSONObject("file")?.let { file ->
                TurnItem.File(
                    id,
                    fileName = file.optString("fileName").ifBlank { "file" },
                    mimeType = (file.opt("mimeType") as? String)?.takeIf { it.isNotBlank() },
                    sizeBytes = (file.opt("sizeBytes") as? Number)?.toLong()?.takeIf { it >= 0 },
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
    /** A tool step's `permission` summary; options without an id or name are dropped. */
    private fun permission(json: JSONObject): ToolPermission? {
        val requestId = json.optString("requestId").ifEmpty { return null }
        val options = json.optJSONArray("options")?.let { array ->
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }.mapNotNull { option ->
                val optionId = option.optString("optionId").ifEmpty { return@mapNotNull null }
                val name = option.optString("name").trim().ifEmpty { return@mapNotNull null }
                PermissionOption(optionId, name, (option.opt("kind") as? String)?.takeIf { it.isNotBlank() })
            }
        }.orEmpty()
        val question = json.optString("kind") == "ask_user_question"
        return ToolPermission(
            requestId, json.optBoolean("pending"), options, question, if (question) questions(json.opt("questionMeta")) else null,
            chosenOptionId = (json.opt("chosenOptionId") as? String)?.ifEmpty { null },
            withdrawn = json.optBoolean("withdrawn"),
        )
    }

    /**
     * The runtime's normalized `questionMeta`, strictly: anything malformed (no questions, a
     * question without header or text, an option without a label) is null, so the request fails
     * closed as not answerable here rather than guessed at.
     */
    internal fun questions(value: Any?): QuestionMeta? {
        val json = value as? JSONObject ?: return null
        val array = json.opt("questions") as? JSONArray ?: return null
        if (array.length() == 0) return null
        val questions = (0 until array.length()).map { index ->
            val question = array.opt(index) as? JSONObject ?: return null
            val header = question.opt("header") as? String ?: return null
            val text = question.opt("question") as? String ?: return null
            val rawOptions = question.opt("options") as? JSONArray ?: return null
            val options = (0 until rawOptions.length()).map { at ->
                val option = rawOptions.opt(at) as? JSONObject ?: return null
                QuestionMeta.Option(
                    option.opt("label") as? String ?: return null,
                    option.opt("description") as? String, option.opt("preview") as? String,
                )
            }
            QuestionMeta.Question(
                id = question.opt("id") as? String, header = header, question = text, options = options,
                multiSelect = question.opt("multiSelect") == true,
                allowCustomAnswer = question.opt("allowCustomAnswer") as? Boolean,
                isSecret = question.opt("isSecret") == true,
            )
        }
        return QuestionMeta(questions, json.opt("allowCustomAnswer") == true)
    }

    /** An answered question's answers from its outcome `_meta` (Lody, Claude or Codex shape), as lists. */
    private fun answers(outcome: JSONObject?): Map<String, List<String>> {
        val meta = outcome?.optJSONObject("_meta") ?: return emptyMap()
        val raw = meta.optJSONObject("lody")?.optJSONObject("elicitation")?.optJSONObject("answers")
            ?: meta.optJSONObject("claudeCode")?.optJSONObject("askUserQuestion")?.optJSONObject("answers")
            ?: meta.optJSONObject("codex")?.optJSONObject("requestUserInput")?.optJSONObject("answers")
            ?: return emptyMap()
        fun strings(value: Any?): List<String>? = when (value) {
            is String -> listOf(value)
            is JSONArray -> (0 until value.length()).mapNotNull { value.opt(it) as? String }
            is JSONObject -> strings(value.opt("answers"))
            else -> null
        }
        return raw.keys().asSequence().mapNotNull { key -> strings(raw.opt(key))?.takeIf { it.isNotEmpty() }?.let { key to it } }.toMap()
    }

    private fun attachments(items: List<JSONObject>) = items.flatMap { item ->
        when (item.optString("type")) {
            "image" -> listOfNotNull(item.optJSONObject("image"))
            "image_group" -> item.optJSONArray("images")?.objects().orEmpty()
            else -> emptyList()
        }.map { MessageAttachment(it.optString("fileName").ifBlank { "image" }, image = true) } +
            listOfNotNull(item.optJSONObject("file")?.takeIf { item.optString("type") == "file" }?.let { MessageAttachment(it.optString("fileName").ifBlank { "file" }, image = false) })
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
