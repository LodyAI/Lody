package app.lody.android.runtime

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Coroutine facade. All WebView access and cancellation cleanup uses the main executor. */
open class WebViewRuntime internal constructor(
    override val scope: RuntimeScope,
    internal val backend: WebViewCloudRuntime,
) : CloudRuntime {
    constructor(context: Context, scope: RuntimeScope) : this(scope, WebViewCloudRuntime(context, "DataRuntime.html"))
    private val mutableState = MutableStateFlow(backend.status)
    override val state: StateFlow<RuntimeStatus> = mutableState.asStateFlow()
    private val mutableEvents = MutableSharedFlow<RuntimeEmission>(extraBufferCapacity = 64)
    override val events: Flow<RuntimeEmission> = mutableEvents.asSharedFlow()
    private var stateSubscription: AutoCloseable? = null
    private var eventSubscription: AutoCloseable? = null
    override suspend fun start() = withContext(Dispatchers.Main.immediate) {
        if (stateSubscription == null) stateSubscription = backend.observe { mutableState.value = it }
        if (eventSubscription == null) eventSubscription = backend.observeEvents { check(mutableEvents.tryEmit(it)) { "event_buffer_full" } }
        backend.start()
    }
    override suspend fun setActive(active: Boolean) = withContext(Dispatchers.Main.immediate) { backend.setActive(active) }
    override suspend fun stop() = withContext(Dispatchers.Main.immediate) {
        backend.stop()
        stateSubscription?.close(); stateSubscription = null
        eventSubscription?.close(); eventSubscription = null
        mutableState.value = backend.status
    }
    override suspend fun execute(command: RuntimeCommand): RuntimeResult = when (command) {
        is RuntimeCommand.ProviderDetail -> RuntimeResult.ProviderDetail(ProviderDetailsJson.detail(call("agentProviderDetail", JSONArray().put(ProviderDetailsJson.target(command.machineId, command.id)), CommandDeadline.QUERY) as JSONObject))
        is RuntimeCommand.ProviderProbe -> RuntimeResult.ProviderProbe(ProviderDetailsJson.probe(call("agentProviderProbe",
            JSONArray().put(ProviderDetailsJson.target(command.machineId, command.id, command.readModelOptions)),
            if (command.readModelOptions) CommandDeadline.PROVIDER_REFRESH else CommandDeadline.PROVIDER_PROBE) as JSONObject))
        is RuntimeCommand.ProviderOperation -> RuntimeResult.ProviderOperation(ProviderDetailsJson.operation(call("agentProviderOperation", JSONArray().put(ProviderDetailsJson.operationParams(command)), CommandDeadline.PROVIDER_OPERATION) as JSONObject))
        is RuntimeCommand.ProviderAuth -> RuntimeResult.ProviderAuth(ProviderDetailsJson.auth(call("agentProviderAuth", JSONArray().put(ProviderDetailsJson.authRequest(command.request)), CommandDeadline.PROVIDER_AUTH) as JSONObject))
        is RuntimeCommand.AgentProviders -> RuntimeResult.AgentProviders(AgentProviderJson.result(call("agentProviders", JSONArray().put(AgentProviderJson.request(command.action)), CommandDeadline.PROVIDER_PROBE) as JSONObject))
        is RuntimeCommand.AgentRoleSettings -> RuntimeResult.RoleSettings(RoleSettingsJson.result(call("agentRoleSettings", JSONArray().put(RoleSettingsJson.request(command.action)),
            if (command.action == RoleSettingsAction.List) CommandDeadline.QUERY else CommandDeadline.WRITE) as JSONObject))
        is RuntimeCommand.ShortcutSettings -> RuntimeResult.ShortcutSettings(ShortcutSettingsJson.result(call("shortcutSettings", JSONArray().put(ShortcutSettingsJson.request(command.action)),
            if (command.action is ShortcutSettingsAction.Save) CommandDeadline.WRITE else CommandDeadline.QUERY) as JSONObject))
        is RuntimeCommand.MessageAction -> {
            val payload = JSONObject(command.payload.toString()).apply { command.billing?.let { put("billingEntitlement", it) } }
            RuntimeResult.MessageAction(call("messageAction", JSONArray().put(command.kind).put(payload), CommandDeadline.WRITE) as JSONObject)
        }
        // Only the cloud runtime reads the plan; without it the free-turn notice stays hidden.
        RuntimeCommand.WorkspacePlan -> RuntimeResult.Plan(null)
        is RuntimeCommand.TurnQuota -> {
            val value = call("turnQuota", JSONArray().put(command.sessionId).put(command.billing ?: JSONObject.NULL), CommandDeadline.QUERY) as JSONObject
            RuntimeResult.Sent(value.optString("state", "allowed"), value.optString("reason").ifBlank { null })
        }
        is RuntimeCommand.SetTabClosed -> {
            call("setTabClosed", JSONArray().put(command.id).put(command.closed), CommandDeadline.WRITE)
            RuntimeResult.Accepted
        }
        is RuntimeCommand.ArchiveSession -> {
            call("archiveSession", JSONArray().put(command.id).put(command.archived), CommandDeadline.WRITE)
            RuntimeResult.Accepted
        }
        is RuntimeCommand.CreateTab -> {
            val value = call("createTab", JSONArray().put(command.parentId).put(command.id).put(command.title).put(backend.preferRoost).put(command.billing ?: JSONObject.NULL), CommandDeadline.WRITE) as JSONObject
            RuntimeResult.Created(CreationReceipt(command.id, value.getString("state"), value.optString("reason").ifBlank { null }))
        }
        is RuntimeCommand.GetCreationOptions -> RuntimeResult.Options(CreationJson.options(call("creationOptions", JSONArray().put(command.projectId ?: JSONObject.NULL).put(command.agentConfigId ?: JSONObject.NULL), CommandDeadline.QUERY) as JSONObject))
        RuntimeCommand.ListAgentRoles -> RuntimeResult.Roles(CreationJson.roles(call("agentRoles", deadline = CommandDeadline.QUERY) as JSONObject))
        RuntimeCommand.ListProjectGroups -> {
            val rows = (call("projectGroups", deadline = CommandDeadline.QUERY) as JSONObject).optJSONArray("groups") ?: JSONArray()
            RuntimeResult.ProjectGroups((0 until rows.length()).map { rows.getJSONObject(it) }.map { group ->
                val members = group.optJSONArray("members") ?: JSONArray()
                ProjectGroup(
                    group.getString("id"), group.optString("name"),
                    group.optString("machineId").takeIf { !group.isNull("machineId") && it.isNotEmpty() },
                    group.optBoolean("conflict"),
                    (0 until members.length()).map { members.getJSONObject(it) }.map { member ->
                        ProjectGroupMember(
                            member.optString("id"), member.optString("kind"), member.optString("label"), member.optString("path"),
                            member.optString("repoFullName").takeIf { it.isNotEmpty() },
                            member.optString("machineId").takeIf { it.isNotEmpty() },
                        )
                    },
                    group.optString("ownerUserId"),
                )
            })
        }
        // Schedule failures arrive in-band as `{error}` (business faults with the runtime's code).
        // Reads replay the whole registry stream under the runtime's own 40 s budget (45 s contract,
        // which iOS waits for); this deadline only fences a lost reply and must not end first.
        RuntimeCommand.ListSchedules -> RuntimeResult.Schedules(ScheduleJson.list(ScheduleJson.checked(call("schedules", deadline = CommandDeadline.SCHEDULE_READ))))
        is RuntimeCommand.ScheduleDetail -> RuntimeResult.Schedule(ScheduleJson.detail(ScheduleJson.checked(call("scheduleDetail", JSONArray().put(command.scheduleId), CommandDeadline.SCHEDULE_READ))))
        is RuntimeCommand.ScheduleCommand -> {
            val value = ScheduleJson.checked(call("scheduleCommand", JSONArray().put(ScheduleJson.command(command.request)), CommandDeadline.WRITE))
            RuntimeResult.ScheduleWritten(value.optString("scheduleId").ifEmpty { command.request.scheduleId })
        }
        is RuntimeCommand.DecideProposal -> {
            val request = JSONObject().put("sessionId", command.sessionId).put("entryId", command.entryId)
                .put("itemId", command.itemId).put("decision", if (command.accept) "accept" else "dismiss")
            // Failures arrive in-band as `{error}` with the runtime's code, like schedule writes.
            val value = ScheduleJson.checked(call("decideProposal", JSONArray().put(request), CommandDeadline.WRITE))
            RuntimeResult.ProposalDecided(value.optString("outcome"), value.optString("scheduleId").ifEmpty { null })
        }
        is RuntimeCommand.RespondPermission -> {
            val args = JSONArray().put(command.sessionId).put(command.entryId).put(command.itemId).put(command.requestId).put(command.optionId)
            // Failures arrive in-band as `{error}` with the runtime's code, like proposal decisions.
            val value = ScheduleJson.checked(call("respondPermission", args, CommandDeadline.WRITE))
            RuntimeResult.PermissionAnswered(value.optString("state").ifEmpty { throw RuntimeException(runtimeFault("invalid_permission_reply")) })
        }
        is RuntimeCommand.ShortcutBody -> RuntimeResult.Shortcut(call("shortcutBody", JSONArray().put(command.id), CommandDeadline.QUERY) as JSONObject)
        is RuntimeCommand.LocalProjects -> {
            val args = JSONArray().put(command.action).put(command.browserId)
                .put(command.machineId ?: JSONObject.NULL).put(command.path ?: JSONObject.NULL).put(command.cursor ?: JSONObject.NULL)
            val deadline = if (command.action == "add") CommandDeadline.WRITE else CommandDeadline.QUERY
            RuntimeResult.LocalProjects(call("localProjects", args, deadline) as JSONObject)
        }
        is RuntimeCommand.MentionCatalog -> {
            val source = command.source
            val args = JSONArray().put(command.category).put(JSONObject().apply {
                source.sessionId?.let { put("sessionId", it) }; source.projectId?.let { put("projectId", it) }
                source.machineId?.let { put("machineId", it) }; source.agentConfigId?.let { put("agentConfigId", it) }
                source.cliType?.let { put("cliType", it) }; source.agentType?.let { put("agentType", it) }
            })
            val value = call("mentionCatalog", args, CommandDeadline.QUERY) as JSONObject
            val items = value.optJSONArray("items") ?: JSONArray()
            RuntimeResult.Mentions(MentionCatalogPage(
                (0 until items.length()).map { items.getJSONObject(it) }.map {
                    MentionCandidate(
                        it.getString("path"), it.optString("name", it.getString("path")), it.optString("kind", "file"),
                        it.optString("subtitle"), it.optString("insertText").ifBlank { null },
                        it.optString("emoji").ifBlank { null },
                    )
                },
                value.optBoolean("truncated"), value.optBoolean("incomplete"),
            ))
        }
        is RuntimeCommand.CreateAndSend -> {
            val request = CreationJson.request(command.request).put("preferRoost", backend.preferRoost)
            command.billing?.let { request.put("billingEntitlement", it) }
            val value = call("createAndSend", JSONArray().put(request), CommandDeadline.WRITE) as JSONObject
            RuntimeResult.Created(CreationReceipt(value.getString("sessionId"), value.getString("state"), value.optString("reason").ifBlank { null }))
        }
        is RuntimeCommand.SendText -> {
            val request = command.request
            val payload = JSONObject()
                .put("sessionId", request.sessionId).put("turnId", request.turnId).put("text", request.text)
                .put("machineId", request.machineId).put("cliType", request.cliType).put("agentType", request.agentType)
                .put("queue", request.queue)
                .put("guide", request.guide)
            request.resume?.let { payload.put("resume", it) }
            if (request.explicitChoice) {
                payload.put("modelId", request.modelId ?: JSONObject.NULL)
                payload.put("effort", request.effort ?: JSONObject.NULL)
            }
            request.modeId?.let { payload.put("modeId", it) }
            when (val role = request.role) {
                RoleSend.Inherit -> Unit
                RoleSend.None -> payload.put("agentRoleId", JSONObject.NULL)
                is RoleSend.Role -> payload.put("agentRoleId", role.id).put("agentConfigId", request.agentConfigId)
            }
            if (request.configOptionValues.isNotEmpty()) payload.put("configOptionValues", JSONObject(request.configOptionValues))
            if (request.attachments.isNotEmpty()) payload.put("attachments", JSONArray(request.attachments))
            command.billing?.let { payload.put("billingEntitlement", it) }
            val value = call("sendText", JSONArray().put(payload), CommandDeadline.WRITE) as JSONObject
            RuntimeResult.Sent(value.optString("state", "unknown"), value.optString("reason").ifBlank { null })
        }
        is RuntimeCommand.WatchSession -> {
            call("watchSession", JSONArray().put(command.id), CommandDeadline.QUERY)
            RuntimeResult.Accepted
        }
        is RuntimeCommand.RetryPendingInput -> {
            call("retryPendingInput", JSONArray().put(command.sessionId).put(command.inputId), CommandDeadline.WRITE)
            RuntimeResult.Accepted
        }
        is RuntimeCommand.ForgetPendingInput -> {
            call("forgetPendingInput", JSONArray().put(command.sessionId).put(command.inputId), CommandDeadline.WRITE)
            RuntimeResult.Accepted
        }
        is RuntimeCommand.LoadOlderSession -> {
            call("loadOlderSession", JSONArray().put(command.id), CommandDeadline.QUERY)
            RuntimeResult.Accepted
        }
        is RuntimeCommand.CloseSession -> {
            call("closeSession", JSONArray().put(command.id))
            RuntimeResult.Accepted
        }
        is RuntimeCommand.ItemDetail -> {
            val value = call("itemDetail", JSONArray().put(command.sessionId).put(command.entryId).put(command.itemId), CommandDeadline.QUERY)
            RuntimeResult.Detail(RuntimeProtocol.detail(value as JSONObject))
        }
        is RuntimeCommand.TurnDiff -> {
            val value = call("turnDiff", JSONArray().put(command.sessionId).put(command.entryId).put(command.path), CommandDeadline.QUERY)
            RuntimeResult.Diff(RuntimeProtocol.diff(value as JSONObject))
        }
        is RuntimeCommand.ListDir -> {
            val value = call("listDir", JSONArray().put(command.sessionId).put(command.relativePath), CommandDeadline.FILE_READ)
            try { RuntimeResult.Directory(RuntimeProtocol.directory(value as JSONObject)) }
            catch (_: Exception) { throw RuntimeException(runtimeFault("invalid_directory")) }
        }
        is RuntimeCommand.ReadFile -> {
            val value = call("readFile", JSONArray().put(command.sessionId).put(command.path), CommandDeadline.FILE_READ)
            RuntimeResult.File(RuntimeProtocol.file(value as? JSONObject ?: JSONObject(), command.path))
        }
        is RuntimeCommand.StopTurn -> {
            call("controlTurn", JSONArray().put(command.sessionId).put(command.machineId).put(command.turnId), CommandDeadline.WRITE)
            RuntimeResult.Accepted
        }
        // The runtime's own 330 s / 100 s budgets end first; these deadlines only fence a lost reply.
        is RuntimeCommand.SessionPreview -> {
            val value = call("sessionPreview", JSONArray().put(command.sessionId).put(if (command.revoke) "revoke" else "create"), CommandDeadline.PREVIEW)
            RuntimeResult.Preview(PreviewJson.browser(value as? JSONObject ?: JSONObject()))
        }
        is RuntimeCommand.DeviceControl -> {
            val args = JSONArray().put(command.sessionId).put(PreviewJson.command(command.platform, command.command))
            val value = call(command.platform.method, args, CommandDeadline.DEVICE_CONTROL)
            RuntimeResult.Device(PreviewJson.reply(command.platform, value as? JSONObject ?: JSONObject()))
        }
        RuntimeCommand.Ping -> RuntimeResult.Pong(call("ping") as? Boolean ?: throw RuntimeException(runtimeFault("invalid_ping_reply")))
        RuntimeCommand.InspectSchema -> {
            val value = call("probeSchema", deadline = CommandDeadline.QUERY)
            try { RuntimeProtocol.schema(value as JSONObject) }
            catch (_: Exception) { throw RuntimeException(runtimeFault("invalid_schema_reply")) }
        }
    }
    internal suspend fun call(method: String, args: JSONArray = JSONArray(), deadline: CommandDeadline = CommandDeadline.CONTROL): Any? = withContext(Dispatchers.Main.immediate) {
        suspendCancellableCoroutine { continuation ->
            val handle = backend.request(method, args, deadline) { result ->
                result.fold(
                    { continuation.resume(it) },
                    { continuation.resumeWithException(RuntimeException(runtimeFault((it as? RuntimeFailure)?.code ?: "runtime_failed"))) },
                )
            }
            continuation.invokeOnCancellation {
                // Cleanup must outlive the cancelled caller, but never own application state.
                android.os.Handler(android.os.Looper.getMainLooper()).post { handle.close() }
            }
        }
    }
}
