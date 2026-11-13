package app.lody.android.runtime

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/** Platform-neutral host contract. Calling coroutines may use any dispatcher. */
interface CloudRuntime {
    val scope: RuntimeScope
    val state: StateFlow<RuntimeStatus>
    val events: Flow<RuntimeEmission>
    suspend fun start()
    suspend fun setActive(active: Boolean)
    suspend fun execute(command: RuntimeCommand): RuntimeResult
    suspend fun stop()
}

data class RuntimeScope(val accountId: String, val workspaceId: String) {
    init { require(accountId.isNotBlank() && workspaceId.isNotBlank()); require(accountId.length <= 128 && workspaceId.length <= 128) }
}
sealed interface RuntimeCommand {
    data class ProviderDetail(val machineId: String, val id: String) : RuntimeCommand
    /** [readModelOptions] switches the agent through every model (Refresh models and modes). */
    data class ProviderProbe(val machineId: String, val id: String, val readModelOptions: Boolean = false) : RuntimeCommand
    data class ProviderOperation(val machineId: String, val id: String?, val action: String, val cliType: String? = null, val agentType: String? = null) : RuntimeCommand
    data class ProviderAuth(val request: ProviderAuthRequest) : RuntimeCommand
    data class AgentProviders(val action: ProviderAction) : RuntimeCommand
    /** Agent Roles settings: list, save (with the listed base) or delete; writes are never replayed. */
    data class AgentRoleSettings(val action: RoleSettingsAction) : RuntimeCommand
    /** Prompt shortcut settings: list, read one body, or save (never replayed). */
    data class ShortcutSettings(val action: ShortcutSettingsAction) : RuntimeCommand
    data class SetTabClosed(val id: String, val closed: Boolean) : RuntimeCommand
    /** Archives or unarchives a conversation (upstream `archiveSession`); a write, never replayed. */
    data class ArchiveSession(val id: String, val archived: Boolean) : RuntimeCommand
    /** [billing]: a Tab is a session, so the free-plan session quota applies (null fails open). */
    data class CreateTab(val parentId: String, val id: String, val title: String, val billing: org.json.JSONObject? = null) : RuntimeCommand
    data class GetCreationOptions(val projectId: String?, val agentConfigId: String? = null) : RuntimeCommand
    /** The workspace's Agent Roles readable by this user. Read only. */
    data object ListAgentRoles : RuntimeCommand
    /** [billing]: the workspace plan projection the cloud runtime reads per write (null fails open). */
    data class CreateAndSend(val request: CreateRequest, val billing: org.json.JSONObject? = null) : RuntimeCommand
    data class SendText(val request: SendTextRequest, val billing: org.json.JSONObject? = null) : RuntimeCommand
    /** The workspace's plan tier (`free` / `plus` / `enterprise`) for the free-turn notice; null when unknown. Read only. */
    data object WorkspacePlan : RuntimeCommand
    /** The free-plan turn quota alone (upstream `checkTurnQuota`), before attachments upload; answers [RuntimeResult.Sent]. Read only. */
    data class TurnQuota(val sessionId: String, val billing: org.json.JSONObject? = null) : RuntimeCommand
    data class WatchSession(val id: String) : RuntimeCommand
    data class LoadOlderSession(val id: String) : RuntimeCommand
    data class RetryPendingInput(val sessionId: String, val inputId: String) : RuntimeCommand
    data class ForgetPendingInput(val sessionId: String, val inputId: String) : RuntimeCommand
    data class CloseSession(val id: String) : RuntimeCommand
    /** One step's detail from the watched session (command, output, diff). Read only. */
    data class ItemDetail(val sessionId: String, val entryId: String, val itemId: String) : RuntimeCommand
    /** One changed file's diff for one turn, from the session's computer. Read only. */
    data class TurnDiff(val sessionId: String, val entryId: String, val path: String) : RuntimeCommand
    /**
     * One folder of the session's local project ([relativePath] from the project root, "" for the
     * root), from the session's computer (upstream `listDir`). Read only.
     */
    data class ListDir(val sessionId: String, val relativePath: String) : RuntimeCommand
    /** One file's contents (upstream `readFile`, at most 2 MiB), from the session's computer. Read only. */
    data class ReadFile(val sessionId: String, val path: String) : RuntimeCommand
    /** One mention category for the composer's @ panel (upstream `mentionCatalog`). Read only. */
    data class MentionCatalog(val category: String, val source: MentionSource) : RuntimeCommand
    /**
     * Add a local folder as a project (upstream `localProjects`): `machines`, `browse`, `add`
     * (a write, never retried) or `cancel`, for one folder browser ([browserId]).
     */
    data class LocalProjects(val action: String, val browserId: String, val machineId: String? = null, val path: String? = null, val cursor: String? = null) : RuntimeCommand
    /** The workspace's multi-repository projects (upstream `projectGroups`). Read only. */
    data object ListProjectGroups : RuntimeCommand
    /** A prompt shortcut's body ({prompt, mentions}) by id, for the composer. Read only. */
    data class ShortcutBody(val id: String) : RuntimeCommand
    /** Stops the watched session's running turn (upstream `controlTurn`). A write, never retried. */
    data class StopTurn(val sessionId: String, val machineId: String, val turnId: String) : RuntimeCommand
    data class MessageAction(val kind: String, val payload: org.json.JSONObject, val billing: org.json.JSONObject? = null) : RuntimeCommand
    /** The workspace's schedules and the zones their rules are authored in. Read only. */
    data object ListSchedules : RuntimeCommand
    /** One schedule with its prompt, model, mode and project. Read only. */
    data class ScheduleDetail(val scheduleId: String) : RuntimeCommand
    /** An owner write (create / edit / pause / resume / run / delete); never retried here. */
    data class ScheduleCommand(val request: ScheduleCommandRequest) : RuntimeCommand
    /** The watched session's managed web preview: open (or reuse) its link, or revoke it. Never retried. */
    data class SessionPreview(val sessionId: String, val revoke: Boolean = false) : RuntimeCommand
    /** One iOS Simulator / Android Emulator lifecycle call for the session (list / start / status / stop). */
    data class DeviceControl(val platform: DevicePlatform, val sessionId: String, val command: DeviceCommand) : RuntimeCommand
    /**
     * Save / create ([accept]) or dismiss an Agent's proposal in the watched session (upstream
     * `decideProposal`); the outcome is recorded in history. A write, never retried here.
     */
    data class DecideProposal(val sessionId: String, val entryId: String, val itemId: String, val accept: Boolean) : RuntimeCommand
    /**
     * Answers a permission request (a plan approval) in the watched session with one of its
     * options (upstream `respondPermission`); answers [RuntimeResult.PermissionAnswered]. A write,
     * never retried here.
     */
    data class RespondPermission(
        val sessionId: String, val entryId: String, val itemId: String, val requestId: String, val optionId: String,
        /** An ask-user-question's answers by [QuestionMeta.key]: a label or text, or a multi-select's labels. */
        val answers: Map<String, Any>? = null,
    ) : RuntimeCommand
    data object Ping : RuntimeCommand
    data object InspectSchema : RuntimeCommand
}
sealed interface RuntimeResult {
    data class ProviderDetail(val value: app.lody.android.runtime.ProviderDetail) : RuntimeResult
    data class ProviderProbe(val value: app.lody.android.runtime.ProviderProbe) : RuntimeResult
    data class ProviderOperation(val value: app.lody.android.runtime.ProviderOperation) : RuntimeResult
    data class ProviderAuth(val value: ProviderAuthState) : RuntimeResult
    data class AgentProviders(val value: app.lody.android.runtime.AgentProviders) : RuntimeResult
    data class RoleSettings(val value: RoleSettingsSnapshot) : RuntimeResult
    data class ShortcutSettings(val value: ShortcutSettingsResult) : RuntimeResult
    data class MessageAction(val value: org.json.JSONObject) : RuntimeResult
    data class Options(val value: CreationOptions) : RuntimeResult
    data class Roles(val value: List<AgentRole>) : RuntimeResult
    data class Mentions(val value: MentionCatalogPage) : RuntimeResult
    /** The `localProjects` outcome as the runtime sent it (`machines`, `directory`, `project`, …). */
    data class LocalProjects(val value: org.json.JSONObject) : RuntimeResult
    data class Shortcut(val value: org.json.JSONObject) : RuntimeResult
    data class ProjectGroups(val value: List<ProjectGroup>) : RuntimeResult
    data class Schedules(val value: ScheduleList) : RuntimeResult
    data class Schedule(val value: app.lody.android.runtime.ScheduleDetail) : RuntimeResult
    /** The schedule a command wrote. */
    data class ScheduleWritten(val scheduleId: String) : RuntimeResult
    /** A proposal's recorded outcome (`saved` / `created` / `dismissed`). */
    data class ProposalDecided(val outcome: String, val scheduleId: String? = null) : RuntimeResult
    /** A permission answer's state: `accepted`, `stale` (the request is gone) or `conflict` (answered elsewhere). */
    data class PermissionAnswered(val state: String) : RuntimeResult
    data class Created(val value: CreationReceipt) : RuntimeResult
    data class Plan(val tier: String?) : RuntimeResult
    /** Upstream send state (`sent` / `queued` / `not_sent` / `unknown`); a machine ACK is delivery only. */
    data class Sent(val state: String, val reason: String? = null) : RuntimeResult
    data object Accepted : RuntimeResult
    data class Detail(val value: StepDetail) : RuntimeResult
    data class Diff(val value: FileDiff) : RuntimeResult
    data class Directory(val value: DirectoryListing) : RuntimeResult
    data class File(val value: FileContent) : RuntimeResult
    data class Pong(val healthy: Boolean) : RuntimeResult
    data class Preview(val value: BrowserPreviewReply) : RuntimeResult
    data class Device(val value: DeviceControlReply) : RuntimeResult
    data class Schema(val machineIds: Set<String>, val creationTrials: Map<String, String>) : RuntimeResult
}
enum class RuntimeErrorCategory { AUTH, NETWORK, PROTOCOL, RUNTIME, BUSINESS, CANCELLED, UNSUPPORTED }
data class RuntimeFault(val code: String, val category: RuntimeErrorCategory)
class RuntimeException(val fault: RuntimeFault) : Exception(fault.code)

/** [repositories]: a multi-repository project's GitHub members (`projectRun`), in member order. */
data class CatalogProject(val id: String, val machineId: String, val name: String, val rootPath: String, val repoFullName: String? = null, val repositories: List<String> = emptyList())
/** [ci] is the web CI verdict code, [merge] GitHub's merge state (`c` clean, `d` conflicts, …); [url] opens it. */
data class CatalogPullRequest(
    val repository: String, val number: Int, val status: String, val ci: String? = null,
    val url: String? = null, val merge: String? = null,
)
/** Required identity / state fields first; the rest are optional display fields (times in epoch ms). */
data class CatalogSession(
    val id: String, val machineId: String, val projectId: String, val title: String, val status: String, val archived: Boolean, val pinned: Boolean, val createdAt: String,
    val branchName: String? = null, val lastMessageAt: Long? = null, val lastReadAt: Long? = null, val awaitingUserSince: Long? = null,
    val pullRequests: List<CatalogPullRequest> = emptyList(),
    /** The owning Lody user (session meta `userId`); null from caches written before the field. */
    val userId: String? = null,
    /** Opened-by relations (Home nests a chat under the one that opened it) and Tab containment. */
    val openedBySessionId: String? = null,
    val openedByRootSessionId: String? = null,
    val parentSessionId: String? = null,
    val childSessionPlacement: String? = null,
    /** The assistant the session runs, needed to send a turn. */
    val cliType: String? = null,
    val agentType: String? = null,
    val resume: String? = null,
    /** The session's own Agent Config (ACP provider); its Roles bind to it. */
    val agentConfigId: String? = null,
    /** The last model's display name, for the agent's header. */
    val modelName: String? = null,
    /** Working tree vs base (`diffStats.allChange`) and git publish state, for the action bar. */
    val diffAdded: Int = 0,
    val diffRemoved: Int = 0,
    val isTabClosed: Boolean = false,
    val workspaceDirty: Boolean = false,
    val workspaceUnpushed: Boolean = false,
    /** Present for Project group conversations. */
    val projectRun: CatalogProjectRun? = null,
    /**
     * Latest user turn the machine finished, and the latest one that ended in failure (session
     * meta `lastHandledUserMsgId` / `lastFailedUserMsgId`); see [ChatListModel.latestTurnFailed].
     */
    val lastHandledUserMsgId: String? = null,
    val lastFailedUserMsgId: String? = null,
    /** The agent asked to show an iOS Simulator / Android Emulator preview (live catalog only, never cached). */
    val iosSimulatorPreviewRequestId: String? = null,
    val androidEmulatorPreviewRequestId: String? = null,
)
/** One repository or folder of a Project group conversation, in placement order (iOS `SessionProjectMember`). */
data class CatalogProjectMember(
    val id: String, val path: String, val kind: String, val depth: Int = 0, val submodule: Boolean = false,
    /** `additional` / `link`: a local folder used in place, with no branch or PR. */
    val access: String? = null,
    val repoFullName: String? = null, val branch: String? = null,
    val diffAdded: Int? = null, val diffRemoved: Int? = null,
    val dirty: Boolean = false, val unpushed: Boolean = false,
    /** The member repository's current PR: the last one recorded for it. */
    val pullRequest: CatalogPullRequest? = null,
) {
    /** Web `repoFullName ?? path`. */
    val identity: String get() = repoFullName ?: path
    val inPlace: Boolean get() = access == "additional" || access == "link"
}
/** The frozen Project group snapshot of a conversation (session meta `projectRun`). */
data class CatalogProjectRun(val id: String, val name: String, val members: List<CatalogProjectMember>) {
    /** Current PRs across members, one per repository. */
    val pullRequests: List<CatalogPullRequest> get() = members.mapNotNull { it.pullRequest }
}
/** Read projection, never a CRDT replica. Optional feature-specific fields come later. */
/** [machineNames] is optional display data (computer id to name); empty from older caches. */
data class CatalogSnapshot(
    val revision: Long,
    val projects: List<CatalogProject>,
    val sessions: List<CatalogSession>,
    val machineIds: List<String>,
    val machineNames: Map<String, String> = emptyMap(),
    /** Computer id to OS (`darwin` / `win32` / `linux`), for its icon. */
    val machineOs: Map<String, String> = emptyMap(),
    val agentUsage: Map<String, ProviderUsage> = emptyMap(),
    /** Computer id to iOS Simulator support (`available` / `upgrade-required`); darwin computers only. */
    val machineSimulators: Map<String, String> = emptyMap(),
    /** Computer id to Android Emulator support (`available`). */
    val machineEmulators: Map<String, String> = emptyMap(),
)
/**
 * One transcript turn. [timestamp] is ISO-8601; [status] is upstream's (`seen` once the agent
 * picked a user turn up, `pending` / `queued` before); [userId] is a user turn's sender;
 * [startedAt] / [endedAt] (epoch ms) time an agent turn; [model] names its model.
 */
data class MessageReference(val start: Int, val end: Int)

data class SessionMessage(
    val id: String,
    val role: String,
    val text: String,
    val streaming: Boolean,
    val references: List<MessageReference> = emptyList(),
    val timestamp: String? = null,
    val status: String = "",
    val userId: String? = null,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    val permissionWaitMs: Long = 0,
    val metadata: Map<String, String> = emptyMap(),
    val model: String? = null,
    /** The turn's items in order (text, thought, tool steps, plans, notices) for the process view. */
    val items: List<TurnItem> = emptyList(),
    val files: List<FileChange> = emptyList(),
    /** A user turn's attachments (images and files), by display name, in order. */
    val attachments: List<MessageAttachment> = emptyList(),
    val operations: List<OperationEvent> = emptyList(),
    val inputRetryable: Boolean = false,
    /** An Agent's Role or schedule proposals (system entries), decided with [RuntimeCommand.DecideProposal]. */
    val proposals: List<ProposalCard> = emptyList(),
)

/**
 * One item of a turn, after upstream's session entry summary. Assistant turns render these as
 * prose, folded thought / tool groups and never-folded plans and notices (web `MessageContent`).
 */
/** One session image: read with the account bearer from the Worker's session-images endpoint. */
data class TurnImage(val id: String, val fileName: String, val storageSessionId: String?, val width: Int?, val height: Int?)

sealed interface TurnItem {
    val id: String

    data class Text(override val id: String, val text: String) : TurnItem
    /** Reasoning; only builtin DSH shows it (web `showThoughts`). */
    data class Thought(override val id: String, val text: String) : TurnItem
    /**
     * A tool step. [kind] is the ACP kind (`execute`, `read`, `edit`, `search`, `fetch`, `think`,
     * `switch_mode`, …); [status] `pending` / `in_progress` / `completed` / `failed`.
     */
    data class Tool(
        override val id: String,
        val kind: String,
        val title: String,
        val status: String,
        val path: String? = null,
        val added: Int? = null,
        val removed: Int? = null,
        val awaitingPermission: Boolean = false,
        /** The runtime holds a detail (command, output, diff) to open under the step. */
        val hasDetail: Boolean = false,
        /** The plan a plan-approval (`switch_mode`) step carries (Claude, Kimi); Codex sends a separate [ProposedPlan]. */
        val plan: String? = null,
        /** The step's permission request, when it has one. */
        val permission: ToolPermission? = null,
    ) : TurnItem
    /** A proposed plan (Markdown); never folded. [streaming] while the agent still writes it. */
    data class ProposedPlan(override val id: String, val markdown: String, val streaming: Boolean = false) : TurnItem
    /** The agent's checklist (`plan`); never folded. */
    data class Checklist(override val id: String, val entries: List<Pair<String, String>>) : TurnItem
    /**
     * Images the agent sent (`image` / `image_group`); never folded. Consecutive ones (only tool
     * work between them) merge into one fanned stack in [app.lody.android.chat.TurnLayout].
     */
    data class Images(override val id: String, val images: List<TurnImage>) : TurnItem
    /**
     * A file the agent shared (`lody_upload_files`, web `SessionFileCard`): its name, type and
     * size; never folded.
     */
    data class File(override val id: String, val fileName: String, val mimeType: String? = null, val sizeBytes: Long? = null) : TurnItem
    /** A failure or notice the turn ended with; never folded. */
    data class Notice(override val id: String, val text: String, val failure: Boolean) : TurnItem
    /**
     * A background task or sub-agent run (web `subagent_task`). [state]: `pending` / `running` /
     * `completed` / `failed` / `cancelled` / `unknown`; [latest] its latest step while it runs;
     * [steps] its own run's items, for its detail sheet.
     */
    data class Task(
        override val id: String,
        val actor: String,
        val description: String,
        val state: String,
        val latest: String = "",
        val result: String = "",
        val background: Boolean = false,
        val steps: List<TurnItem> = emptyList(),
        /** Web `groupOf`, from the runtime: `subagents` (agent runs) or `tasks` (commands, MCP tasks, monitors, wakeups). */
        val group: String = "subagents",
    ) : TurnItem {
        val running: Boolean get() = state == "pending" || state == "running"
    }
}

/** A text turn in an existing conversation; [turnId] is stable so a retry can never duplicate it. */
data class SendTextRequest(
    val sessionId: String,
    val turnId: String,
    val text: String,
    val machineId: String,
    val cliType: String,
    val agentType: String,
    val resume: String? = null,
    val queue: Boolean = false,
    /**
     * The composer's run config once the reader changed it ([explicitChoice]): then a null model
     * or effort clears it to the agent default (iOS `sendChoice`); otherwise every field is
     * omitted and upstream keeps the session's previous one. A null mode always keeps it.
     */
    val modelId: String? = null,
    val modeId: String? = null,
    val effort: String? = null,
    val explicitChoice: Boolean = false,
    /** Uploaded attachment blocks (`image` / `file`, server references only), in order. */
    val attachments: List<org.json.JSONObject> = emptyList(),
    /** The turn's Agent Role (web session composer); [RoleSend.Inherit] omits it. */
    val role: RoleSend = RoleSend.Inherit,
    /** The session's own Agent Config, which a Role must be bound to. */
    val agentConfigId: String? = null,
    /** Agent switches the reader changed (Plan, Fast); empty sends none. */
    val configOptionValues: Map<String, Any> = emptyMap(),
    /** Steer the running reply instead of queueing (the "Guide" preference, when the agent can steer). */
    val guide: Boolean = false,
)
/** What a turn says about its Agent Role: inherit the latest turn's, an explicit None, or a Role. */
sealed interface RoleSend {
    data object Inherit : RoleSend
    data object None : RoleSend
    data class Role(val id: String) : RoleSend
}
data class MessageAttachment(val name: String, val image: Boolean)
/**
 * The latest user turn's run config (runtime session `composer`), what the next turn would use.
 * [roleKnown] is false when the turn says nothing about a Role; then [agentRoleId] null is
 * unknown rather than an explicit None.
 */
data class RunChoice(
    val modelId: String? = null, val modeId: String? = null, val effort: String? = null,
    val configOptionValues: Map<String, Any> = emptyMap(),
    val agentRoleId: String? = null, val roleKnown: Boolean = false,
)
/** [preview]: the session's managed web preview candidate, null without one. */
data class SessionSnapshot(
    val id: String,
    val status: String,
    val messages: List<SessionMessage>,
    val composer: RunChoice? = null,
    val usage: SessionUsage? = null,
    val preview: BrowserPreview? = null,
    val historyHasMore: Boolean = false,
    val historyLoading: Boolean = false,
    /** User turns plus queued inputs, as the free-plan turn quota counts them; null when unknown. */
    val billableTurnCount: Int? = null,
)
sealed interface RuntimeEvent {
    data class ProvidersChanged(val machineId: String) : RuntimeEvent
    data class ProviderProgress(val machineId: String, val id: String, val status: String, val percent: Float?) : RuntimeEvent
    /** A refresh is reading [modelName]'s options, [index] of [total] (1-based). */
    data class ProviderRefreshProgress(val machineId: String, val id: String, val modelName: String, val index: Int, val total: Int) : RuntimeEvent
    data class CreationChanged(val key: String = "") : RuntimeEvent
    data class SessionUpdated(val snapshot: SessionSnapshot) : RuntimeEvent
    data class CatalogUpdated(val snapshot: CatalogSnapshot) : RuntimeEvent
    data class Synced(val revision: Long, val streams: Int) : RuntimeEvent
    data class SyncFailed(val reason: String) : RuntimeEvent
    data object GrantRequested : RuntimeEvent
    /** The runtime asks the native host to make one prompt-shortcut Convex call (iOS `shortcutCloud`). */
    data class ShortcutCloudRequested(val requestId: String, val operation: String, val args: String) : RuntimeEvent
    /** The runtime asks the native host to mint a preview proof's request token for [intent] (JSON). */
    data class PreviewTokenRequested(val requestId: String, val intent: String) : RuntimeEvent
}
/** Stamped at source receipt, before any coroutine buffering. */
data class RuntimeEmission(val generation: Long, val event: RuntimeEvent)
data class ScopedRuntimeEvent(val scope: RuntimeScope, val event: RuntimeEvent, val generation: Long)
data class OwnedRuntimeState(val scope: RuntimeScope? = null, val status: RuntimeStatus = RuntimeStatus())

/** Stage-2 port. Phase 1 has no credential provider implementation or cloud capability. */
fun interface GrantProvider { suspend fun request(scope: RuntimeScope): ShortLivedGrant }
/** Makes one allow-listed `promptShortcuts:*` Convex call for [scope] with the verified account; throws on failure. */
/** Reads [scope]'s workspace plan projection with the verified account; null (or a throw) fails open. */
fun interface BillingProvider { suspend fun entitlement(scope: RuntimeScope): org.json.JSONObject? }
fun interface ShortcutCloudProvider { suspend fun call(scope: RuntimeScope, operation: String, args: org.json.JSONObject): Any? }
/**
 * Mints one preview-control request token for [scope] with the verified account: the token string,
 * or the HTTP status (Int) the backend refused with; throws on any other failure.
 */
fun interface PreviewTokenProvider { suspend fun mint(scope: RuntimeScope, intent: org.json.JSONObject): Any }
class ShortLivedGrant(val token: String, val gatewayBaseUrl: String, val expiresIn: Int, private val receivedAtNanos: Long = System.nanoTime()) {
    init { require(token.isNotBlank()); require(expiresIn in 1..3600) }
    fun remainingSeconds(nowNanos: Long = System.nanoTime()): Int =
        (expiresIn - ((nowNanos - receivedAtNanos).coerceAtLeast(0) / 1_000_000_000L)).coerceAtLeast(0).toInt()
    override fun toString() = "ShortLivedGrant(token=<redacted>, expiresIn=$expiresIn)"
}

/**
 * A tool step's detail, after upstream `itemDetail`: its content blocks in order. [truncated] when
 * the runtime cut a long detail; the rest stays on desktop.
 */
data class StepDetail(
    val blocks: List<StepBlock>,
    val truncated: Boolean = false,
    /** An answered ask-user-question's answers by question key (the outcome's `_meta`), each as its labels or text. */
    val answers: Map<String, List<String>> = emptyMap(),
)

/** A tool step's permission request (web `permissionRequest`): [pending] until answered or withdrawn. */
data class ToolPermission(
    val requestId: String,
    val pending: Boolean,
    val options: List<PermissionOption>,
    /** An ask-user-question request (runtime `kind`), answered with [questions]. */
    val question: Boolean = false,
    /** The questions, or null when absent or malformed: such a question is not answerable here. */
    val questions: QuestionMeta? = null,
    /** The option a settled request was answered with (runtime `chosenOptionId`). */
    val chosenOptionId: String? = null,
    /** A settled request that was withdrawn (cancelled), not answered. */
    val withdrawn: Boolean = false,
) {
    /**
     * Desktop `resolveSuggestedOptionId`: a request that leads with a refusal suggests the first
     * one-time refusal; otherwise the first one-time allow, never an "always"; else the first option.
     */
    val suggested: PermissionOption? get() {
        val first = options.firstOrNull() ?: return null
        if (first.tone == "reject" || first.tone == "rejectAlways") options.firstOrNull { it.tone == "reject" }?.let { return it }
        return options.firstOrNull { it.tone == "allow" } ?: first
    }
}

/** Ask-user-question metadata as the runtime normalized it (`parseQuestionMeta`). */
data class QuestionMeta(val questions: List<Question>, val allowCustomAnswer: Boolean) {
    data class Option(val label: String, val description: String? = null, val preview: String? = null)
    data class Question(
        val id: String?, val header: String, val question: String, val options: List<Option>,
        val multiSelect: Boolean, val allowCustomAnswer: Boolean? = null, val isSecret: Boolean = false,
    )

    /** Runtime `questionAnswerKey`: the first of id, question, header that is non-blank and unique, else the index. */
    fun key(index: Int): String {
        val question = questions[index]
        for (field in listOf<(Question) -> String?>({ it.id }, { it.question }, { it.header })) {
            val value = field(question)
            if (!value.isNullOrBlank() && questions.count { field(it) == value } == 1) return value
        }
        return index.toString()
    }

    /** Runtime `questionAllowsText`. */
    fun allowsText(index: Int): Boolean = questions[index].let { it.options.isEmpty() || (it.allowCustomAnswer ?: allowCustomAnswer) }
}

/** One option the provider offers; [kind] is ACP's `allow_once` / `allow_always` / `reject_once` / …. */
data class PermissionOption(val optionId: String, val name: String, val kind: String?) {
    val allows: Boolean get() = kind?.startsWith("allow") == true
    /** Desktop `resolvePermissionOptionTone`: `allow`, `allowAlways`, `reject` (also Lody's `deny`), `rejectAlways` or `other`. */
    val tone: String get() = when (kind) {
        "allow_once" -> "allow"
        "allow_always" -> "allowAlways"
        "reject_once", "deny" -> "reject"
        "reject_always" -> "rejectAlways"
        else -> "other"
    }
}

sealed interface StepBlock {
    data class Command(val command: String, val cwd: String? = null) : StepBlock
    data class Output(val text: String, val exitCode: Int? = null) : StepBlock
    data class Diff(val path: String, val oldText: String, val newText: String) : StepBlock
    data class Text(val text: String) : StepBlock
}

/** One file a turn changed (upstream entry `fileDiffs`). */
data class FileChange(val path: String, val added: Int, val removed: Int)

/**
 * A file's text before and after a turn (upstream `turnDiff`). [oldText] / [newText] are null for a
 * side that is not text (binary, too large); [unavailable] carries the computer's reason when it
 * could not produce the diff (offline, file gone).
 */
data class FileDiff(
    val path: String,
    val oldText: String?,
    val newText: String?,
    val added: Int? = null,
    val removed: Int? = null,
    val unavailable: String? = null,
)

/** One folder of a local project (upstream `DirectoryListing`): folders first, then files, by name. */
data class DirectoryListing(val entries: List<DirectoryEntry>, val truncated: Boolean)
data class DirectoryEntry(val name: String, val directory: Boolean)

/** One file read from the session's computer (upstream `FileContent`). */
sealed interface FileContent {
    val path: String
    data class Text(override val path: String, val text: String, val bytes: Long) : FileContent
    data class Binary(override val path: String, val bytes: Long) : FileContent
    /** The computer's refusal (`file_not_found`, `too_large`, `permission_denied`, …). */
    data class Failed(override val path: String, val code: String) : FileContent
}

/** One mention candidate (upstream `MentionCatalog` item); [insertText] defaults to `@path`. */
data class MentionCandidate(
    val path: String, val name: String, val kind: String, val subtitle: String = "", val insertText: String? = null,
    /** A Role's emoji: it leads the row instead of an icon (as the run-config Role row). */
    val emoji: String? = null,
) {
    /**
     * Folders browse with the files; prompt shortcuts (listed with the agent's commands, inserting
     * `/shortcut:<slug>`) are their own category, as web's mention menu and iOS.
     */
    val category: String get() = when {
        kind == "directory" -> "file"
        kind == "cmd" && insertText?.startsWith("/shortcut:") == true -> "shortcut"
        else -> kind
    }
}
/** What references come from: a conversation, or the new-chat page's selection (iOS `MentionSource`). */
data class MentionSource(
    val sessionId: String? = null, val projectId: String? = null, val machineId: String? = null,
    val agentConfigId: String? = null, val cliType: String? = null, val agentType: String? = null,
)
data class MentionCatalogPage(val items: List<MentionCandidate>, val truncated: Boolean = false, val incomplete: Boolean = false)

/**
 * A multi-repository project (web Project group): its repositories and local folders start
 * together in one conversation. [machineId] is the computer its local members pin (null: any);
 * [conflict] groups (local members on two computers) cannot start one.
 */
/** A workspace Project group (multi-repository project); only [ownerUserId] may edit it, on desktop. */
data class ProjectGroup(
    val id: String, val name: String, val machineId: String?, val conflict: Boolean, val members: List<ProjectGroupMember>,
    val ownerUserId: String = "",
)
/** [kind] is `github` or `local`; [label] is the repository or the local project's name. */
data class ProjectGroupMember(
    val id: String, val kind: String, val label: String, val path: String,
    val repoFullName: String? = null, val machineId: String? = null,
)

