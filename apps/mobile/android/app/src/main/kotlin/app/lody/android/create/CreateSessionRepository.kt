package app.lody.android.create

import app.lody.android.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.FlowPreview

interface CreationOptionsStore {
    suspend fun readBranches(scope: RuntimeScope, repo: String): BranchCache? = null
    suspend fun writeBranches(scope: RuntimeScope, repo: String, page: BranchPage) {}
    suspend fun selectBranch(scope: RuntimeScope, repo: String, name: String) {}

    suspend fun readOptions(scope: RuntimeScope, projectId: String?): CreationOptions?
    suspend fun writeOptions(scope: RuntimeScope, projectId: String?, options: CreationOptions)
}

interface CreationService {
    suspend fun refreshCapability(scope: RuntimeScope, agentConfigId: String) {}
    fun observeOptions(scope: RuntimeScope): Flow<CreationOptions?> = flow { emit(options(scope, null)) }
    suspend fun cachedBranches(scope: RuntimeScope, repo: String): BranchCache? = null
    suspend fun branches(scope: RuntimeScope, repo: String, page: Int): BranchPage = error("branches_unavailable")
    suspend fun cacheBranches(scope: RuntimeScope, repo: String, page: BranchPage) {}
    suspend fun selectBranch(scope: RuntimeScope, repo: String, name: String) {}

    suspend fun cachedOptions(scope: RuntimeScope, projectId: String?): CreationOptions? = null
    /** The workspace's Agent Roles for the Role row; none where there is no runtime. */
    suspend fun roles(scope: RuntimeScope): List<AgentRole> = emptyList()
    /** One mention category for the composer's @ panel; none where there is no runtime. */
    suspend fun mentions(scope: RuntimeScope, category: String, source: MentionSource): MentionCatalogPage = MentionCatalogPage(emptyList())
    /** The workspace's multi-repository projects for the picker; none without a runtime. */
    suspend fun projectGroups(scope: RuntimeScope): List<ProjectGroup> = emptyList()
    /** A prompt shortcut's body ({prompt, mentions}) for the composer; none without a runtime. */
    suspend fun shortcut(scope: RuntimeScope, id: String): org.json.JSONObject = throw IllegalStateException("shortcut_unavailable")
    suspend fun options(scope: RuntimeScope, projectId: String?): CreationOptions
    suspend fun create(scope: RuntimeScope, request: CreateRequest): CreationReceipt
}

/** Uses the existing verified account/workspace lease; never retries a mutation. */
class CreateSessionRepository(private val owner: RuntimeOwner, private val store: CreationOptionsStore,
    private val branchLoader: suspend (RuntimeScope, String, Int) -> BranchPage = { _, _, _ -> error("branches_unavailable") }
) : CreationService {
    override suspend fun refreshCapability(scope: RuntimeScope, agentConfigId: String) {
        owner.use(scope) { it.execute(RuntimeCommand.GetCreationOptions(null, agentConfigId)) }
    }
    @OptIn(FlowPreview::class)
    override fun observeOptions(scope: RuntimeScope): Flow<CreationOptions?> {
        val changes = owner.events.filter {
            it.scope == scope && it.generation == owner.state.value.status.generation &&
                (it.event is RuntimeEvent.Synced || it.event is RuntimeEvent.CreationChanged || it.event is RuntimeEvent.SyncFailed)
        }.map { Unit }
        val readiness = owner.state.map { Triple(it.scope, it.status.phase, it.status.generation) }.distinctUntilChanged().map { Unit }
        return merge(changes, readiness).debounce(150).map {
            if (owner.state.value.scope != scope || owner.state.value.status.phase != RuntimePhase.READY) null
            else try {
                owner.use(scope) { (it.execute(RuntimeCommand.GetCreationOptions(null)) as RuntimeResult.Options).value }
                    .takeUnless { it.availability == "unknown" }
            }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
        }.distinctUntilChanged().onEach { value ->
            if (value != null) {
                try { store.writeOptions(scope, null, value) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { }
            }
        }
    }
    override suspend fun cachedBranches(scope: RuntimeScope, repo: String) = store.readBranches(scope, repo)
    override suspend fun branches(scope: RuntimeScope, repo: String, page: Int) = branchLoader(scope, repo, page)
    override suspend fun cacheBranches(scope: RuntimeScope, repo: String, page: BranchPage) = store.writeBranches(scope, repo, page)
    override suspend fun selectBranch(scope: RuntimeScope, repo: String, name: String) = store.selectBranch(scope, repo, name)

    override suspend fun cachedOptions(scope: RuntimeScope, projectId: String?) = store.readOptions(scope, projectId)
    override suspend fun roles(scope: RuntimeScope): List<AgentRole> = owner.use(scope) {
        (it.execute(RuntimeCommand.ListAgentRoles) as RuntimeResult.Roles).value
    }
    override suspend fun projectGroups(scope: RuntimeScope): List<ProjectGroup> = owner.use(scope) {
        (it.execute(RuntimeCommand.ListProjectGroups) as RuntimeResult.ProjectGroups).value
    }
    override suspend fun shortcut(scope: RuntimeScope, id: String): org.json.JSONObject = owner.use(scope) {
        (it.execute(RuntimeCommand.ShortcutBody(id)) as RuntimeResult.Shortcut).value
    }
    override suspend fun mentions(scope: RuntimeScope, category: String, source: MentionSource): MentionCatalogPage = owner.use(scope) {
        (it.execute(RuntimeCommand.MentionCatalog(category, source)) as RuntimeResult.Mentions).value
    }
    override suspend fun options(scope: RuntimeScope, projectId: String?): CreationOptions = owner.use(scope) {
        val value = (it.execute(RuntimeCommand.GetCreationOptions(projectId)) as RuntimeResult.Options).value
        try { if (value.availability != "unknown") store.writeOptions(scope, projectId, value) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* Disk failure must not hide live choices. */ }
        value
    }
    override suspend fun create(scope: RuntimeScope, request: CreateRequest): CreationReceipt = owner.use(scope) {
        (it.execute(RuntimeCommand.CreateAndSend(request)) as RuntimeResult.Created).value
    }
}
