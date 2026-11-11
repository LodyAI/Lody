package app.lody.android.chat

import app.lody.android.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** Merge (`method`) or mark ready (`method` null) one PR with the scope's verified account. */
fun interface PullRequestWriter {
    suspend fun write(scope: RuntimeScope, repository: String, number: Int, method: String?)
}

/** GitHub's merge state for one PR with the scope's verified account; null while GitHub computes it. */
fun interface PullRequestMergeReader {
    suspend fun read(scope: RuntimeScope, repository: String, number: Int): String?
}

/** A PR's state, branch and ±lines from GitHub with the scope's verified account; a read. */
fun interface PullRequestDetailsReader {
    suspend fun read(scope: RuntimeScope, repository: String, number: Int): PullRequestDetails
}

/** A merged PR's own head branch, with the scope's verified account: probed (a read) and deleted (a write, never retried). */
interface PullRequestBranches {
    /** Null when it does not apply (not merged, a fork's head) or GitHub gave no answer. */
    suspend fun exists(scope: RuntimeScope, repository: String, number: Int): Boolean?
    suspend fun delete(scope: RuntimeScope, repository: String, number: Int)
}

private object UnavailableBranches : PullRequestBranches {
    override suspend fun exists(scope: RuntimeScope, repository: String, number: Int): Boolean? = null
    override suspend fun delete(scope: RuntimeScope, repository: String, number: Int) = throw GitHubWriteFailure("unavailable")
}

/** A screen subscription uses the app's existing workspace lease; it never creates a runtime. */
class ChatRepository(
    private val owner: RuntimeOwner,
    private val pullRequests: PullRequestWriter = PullRequestWriter { _, _, _, _ -> throw GitHubWriteFailure("unavailable") },
    private val attachments: AttachmentUploader = AttachmentUploader { _, _, _ -> throw AttachmentFailure("unavailable") },
    private val mergeStates: PullRequestMergeReader = PullRequestMergeReader { _, _, _ -> throw GitHubWriteFailure("unavailable") },
    private val branches: PullRequestBranches = UnavailableBranches,
    private val details: PullRequestDetailsReader = PullRequestDetailsReader { _, _, _ -> throw GitHubWriteFailure("unavailable") },
) {
    /** Uploads a turn's attachments natively; only the returned references reach the runtime. */
    suspend fun upload(scope: RuntimeScope, sessionId: String, items: List<PendingAttachment>): List<org.json.JSONObject> =
        if (items.isEmpty()) emptyList() else attachments.upload(scope, sessionId, items)

    suspend fun messageAction(scope: RuntimeScope, kind: String, payload: org.json.JSONObject): org.json.JSONObject =
        owner.use(scope) { (it.execute(RuntimeCommand.MessageAction(kind, payload)) as RuntimeResult.MessageAction).value }

    suspend fun setTabClosed(scope: RuntimeScope, id: String, closed: Boolean) {
        owner.use(scope) { it.execute(RuntimeCommand.SetTabClosed(id, closed)) }
    }

    suspend fun createTab(scope: RuntimeScope, parentId: String, id: String, title: String): CreationReceipt =
        owner.use(scope) { (it.execute(RuntimeCommand.CreateTab(parentId, id, title)) as RuntimeResult.Created).value }

    /** One step's detail from the watched session's replica; a read, safe to retry. */
    suspend fun detail(scope: RuntimeScope, sessionId: String, entryId: String, itemId: String): StepDetail =
        owner.use(scope) { (it.execute(RuntimeCommand.ItemDetail(sessionId, entryId, itemId)) as RuntimeResult.Detail).value }

    /** A changed file's diff for one turn, read from the session's computer; safe to retry. */
    suspend fun turnDiff(scope: RuntimeScope, sessionId: String, entryId: String, path: String): FileDiff =
        owner.use(scope) { (it.execute(RuntimeCommand.TurnDiff(sessionId, entryId, path)) as RuntimeResult.Diff).value }

    /** A direct GitHub write from the action bar; never retried (see [GitHubPullRequestWrites]). */
    suspend fun mergePullRequest(scope: RuntimeScope, repository: String, number: Int, method: String) =
        pullRequests.write(scope, repository, number, method)

    suspend fun markReady(scope: RuntimeScope, repository: String, number: Int) =
        pullRequests.write(scope, repository, number, null)

    /** A read, safe to repeat: whether a merged PR's head branch still exists (the PR panel's Delete branch). */
    suspend fun headBranchExists(scope: RuntimeScope, repository: String, number: Int): Boolean? =
        branches.exists(scope, repository, number)

    /** A direct GitHub write from the PR panel; never retried. */
    suspend fun deleteBranch(scope: RuntimeScope, repository: String, number: Int) =
        branches.delete(scope, repository, number)

    /** A read, safe to repeat: the PR panel's state for a PR opened from a link. */
    suspend fun pullRequestDetails(scope: RuntimeScope, repository: String, number: Int): PullRequestDetails =
        details.read(scope, repository, number)

    /** A read, safe to repeat: used to settle the merge state after Ready for review. */
    suspend fun mergeState(scope: RuntimeScope, repository: String, number: Int): String? =
        mergeStates.read(scope, repository, number)

    /** The project's provider choices (models, efforts, modes) for the composer's run config; a read. */
    suspend fun options(scope: RuntimeScope, projectId: String?): CreationOptions =
        owner.use(scope) { (it.execute(RuntimeCommand.GetCreationOptions(projectId)) as RuntimeResult.Options).value }

    /** Agent Roles readable by this user, for the conversation's Role row; a read. */
    suspend fun roles(scope: RuntimeScope): List<AgentRole> =
        owner.use(scope) { (it.execute(RuntimeCommand.ListAgentRoles) as RuntimeResult.Roles).value }

    /** One mention category for the composer's @ panel; a read, safe to retry. */
    suspend fun mentions(scope: RuntimeScope, category: String, session: CatalogSession?): MentionCatalogPage =
        owner.use(scope) {
            val source = MentionSource(sessionId = session?.id, cliType = session?.cliType, agentType = session?.agentType)
            (it.execute(RuntimeCommand.MentionCatalog(category, source)) as RuntimeResult.Mentions).value
        }

    /** A prompt shortcut's body ({prompt, mentions}); a read. */
    suspend fun shortcut(scope: RuntimeScope, id: String): org.json.JSONObject =
        owner.use(scope) { (it.execute(RuntimeCommand.ShortcutBody(id)) as RuntimeResult.Shortcut).value }

    /** Stops the running turn; never retried (a lost reply is reported, not replayed). */
    suspend fun stop(scope: RuntimeScope, sessionId: String, machineId: String, turnId: String) {
        owner.use(scope) { it.execute(RuntimeCommand.StopTurn(sessionId, machineId, turnId)) }
    }

    /** Sends one text turn on the scope's lease. Never retried: an uncertain write is `unknown`. */
    suspend fun send(scope: RuntimeScope, request: SendTextRequest): RuntimeResult.Sent =
        owner.use(scope) { it.execute(RuntimeCommand.SendText(request)) as RuntimeResult.Sent }

    fun observe(scope: RuntimeScope, id: String): Flow<SessionSnapshot> = channelFlow {
        var latest = SessionSnapshot(id, "syncing", emptyList())
        suspend fun status(value: String) { latest = latest.copy(status = value); send(latest) }
        val events = launch(start = CoroutineStart.UNDISPATCHED) {
            owner.events.collect { emission ->
                val event = emission.event as? RuntimeEvent.SessionUpdated ?: return@collect
                if (emission.scope == scope && emission.generation == owner.state.value.status.generation && event.snapshot.id == id) {
                    latest = event.snapshot
                    send(latest)
                }
            }
        }
        try {
            owner.state.map { Triple(it.scope, it.status.generation, it.status.phase) }.distinctUntilChanged().collectLatest { (current, _, phase) ->
                if (current != scope || phase != RuntimePhase.READY) {
                    status(if (phase == RuntimePhase.STARTING) "syncing" else "offline")
                    return@collectLatest
                }
                // READY precedes the grant/connect handshake. Retry the read, never a write.
                while (currentCoroutineContext().isActive) {
                    try {
                        status("syncing")
                        owner.use(scope) { it.execute(RuntimeCommand.WatchSession(id)) }
                        break
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { status("offline"); delay(2_000) }
                }
                awaitCancellation()
            }
        } finally {
            events.cancel()
            withContext(NonCancellable) {
                try { owner.use(scope) { it.execute(RuntimeCommand.CloseSession(id)) } }
                catch (_: Exception) { /* A replaced/suspended runtime already fences this lease. */ }
            }
        }
    }.conflate()
}
