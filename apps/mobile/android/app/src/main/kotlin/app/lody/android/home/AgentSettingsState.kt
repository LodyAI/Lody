package app.lody.android.home

import androidx.compose.runtime.*
import app.lody.android.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

interface AgentProviderService {
    fun changes(scope: RuntimeScope): Flow<String> = emptyFlow()
    fun progress(scope: RuntimeScope): Flow<RuntimeEvent.ProviderProgress> = emptyFlow()
    suspend fun detail(scope: RuntimeScope, machineId: String, id: String): ProviderDetail = error("provider_detail_unavailable")
    suspend fun probe(scope: RuntimeScope, machineId: String, id: String): ProviderProbe = error("provider_probe_unavailable")
    /** Refreshes the provider and reads every model's options; [refreshProgress] names each model. */
    suspend fun refreshModels(scope: RuntimeScope, machineId: String, id: String): ProviderProbe = probe(scope, machineId, id)
    fun refreshProgress(scope: RuntimeScope): Flow<RuntimeEvent.ProviderRefreshProgress> = emptyFlow()
    suspend fun operation(scope: RuntimeScope, machineId: String, id: String?, action: String, cliType: String? = null, agentType: String? = null): ProviderOperation = error("provider_operation_unavailable")
    suspend fun auth(scope: RuntimeScope, request: ProviderAuthRequest): ProviderAuthState = error("provider_auth_unavailable")
    suspend fun perform(scope: RuntimeScope, action: ProviderAction): AgentProviders
}
class RuntimeAgentProviderService(private val owner: RuntimeOwner) : AgentProviderService {
    override fun changes(scope: RuntimeScope): Flow<String> = owner.events.filter { it.scope == scope }.mapNotNull { (it.event as? RuntimeEvent.ProvidersChanged)?.machineId }
    override fun progress(scope: RuntimeScope): Flow<RuntimeEvent.ProviderProgress> = owner.events.filter { it.scope == scope }.mapNotNull { it.event as? RuntimeEvent.ProviderProgress }
    override suspend fun detail(scope: RuntimeScope, machineId: String, id: String) = owner.use(scope) { (it.execute(RuntimeCommand.ProviderDetail(machineId, id)) as RuntimeResult.ProviderDetail).value }
    override suspend fun probe(scope: RuntimeScope, machineId: String, id: String) = owner.use(scope) { (it.execute(RuntimeCommand.ProviderProbe(machineId, id)) as RuntimeResult.ProviderProbe).value }
    override suspend fun refreshModels(scope: RuntimeScope, machineId: String, id: String) = owner.use(scope) {
        (it.execute(RuntimeCommand.ProviderProbe(machineId, id, readModelOptions = true)) as RuntimeResult.ProviderProbe).value
    }
    override fun refreshProgress(scope: RuntimeScope): Flow<RuntimeEvent.ProviderRefreshProgress> =
        owner.events.filter { it.scope == scope }.mapNotNull { it.event as? RuntimeEvent.ProviderRefreshProgress }
    override suspend fun operation(scope: RuntimeScope, machineId: String, id: String?, action: String, cliType: String?, agentType: String?) = owner.use(scope) { (it.execute(RuntimeCommand.ProviderOperation(machineId, id, action, cliType, agentType)) as RuntimeResult.ProviderOperation).value }
    override suspend fun auth(scope: RuntimeScope, request: ProviderAuthRequest) = owner.use(scope) { (it.execute(RuntimeCommand.ProviderAuth(request)) as RuntimeResult.ProviderAuth).value }
    override suspend fun perform(scope: RuntimeScope, action: ProviderAction): AgentProviders = owner.use(scope) {
        (it.execute(RuntimeCommand.AgentProviders(action)) as RuntimeResult.AgentProviders).value
    }
}

/** One screen/scope owns reads; writes are never replayed, and stale display never grants editing. */
internal class AgentSettingsState(private val service: AgentProviderService, private val scope: RuntimeScope) {
    private val operations = Mutex()
    /** The last accepted list for this scope shows at once; it never grants editing ([live]). */
    var snapshot by mutableStateOf(remembered?.takeIf { it.first == scope }?.second); private set
    var busy by mutableStateOf(false); private set
    var live by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var authRequired by mutableStateOf(false); private set
    /** The provider whose models are being read, and the model being read right now. */
    var refreshing by mutableStateOf<String?>(null); private set
    var refreshProgress by mutableStateOf<RuntimeEvent.ProviderRefreshProgress?>(null); private set
    fun onRefreshProgress(progress: RuntimeEvent.ProviderRefreshProgress) {
        if (progress.id == refreshing) refreshProgress = progress
    }
    /** Refreshes one provider through every model, then reads the list again. Never replayed. */
    suspend fun refreshModels(provider: AgentProvider): Boolean {
        if (busy || !live || !canManage(snapshot?.machines?.find { it.id == provider.machineId })) return false
        if (!operations.tryLock()) return false
        busy = true; error = null; authRequired = false
        refreshing = provider.id; refreshProgress = null
        val result = try { service.refreshModels(scope, provider.machineId, provider.id) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            error = (failure as? app.lody.android.runtime.RuntimeException)?.fault?.code ?: "provider_write_unknown"
            null
        } finally { busy = false; refreshing = null; refreshProgress = null; operations.unlock() }
        if (result != null) authRequired = result.authRequired
        refresh(provider.machineId)
        return result?.success == true
    }
    suspend fun refresh(machineId: String? = null) = operations.withLock {
        busy = true
        try {
            val result = service.perform(scope, machineId?.let { ProviderAction.ListMachine(it) } ?: ProviderAction.List)
            merge(result, machineId)
            live = true; error = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { live = false; error = "provider_load_failed" }
        finally { busy = false }
    }
    fun canManage(machine: ProviderMachine?) = live && !busy && machine?.canManage == true
    suspend fun perform(action: ProviderAction): Boolean {
        if (busy || !live || action == ProviderAction.List) return false
        val machineId = when (action) {
            is ProviderAction.Save -> action.machineId
            is ProviderAction.Delete -> action.base.machineId
            is ProviderAction.Refresh -> action.base.machineId
            is ProviderAction.RetrySetup -> action.setup.machineId
            is ProviderAction.DeleteSetup -> action.setup.machineId
            ProviderAction.List, is ProviderAction.ListMachine -> return false
        }
        if (!canManage(snapshot?.machines?.find { it.id == machineId })) return false
        if (!operations.tryLock()) return false
        busy = true; error = null
        val previous = snapshot
        // Deletions leave the list at once and come back if the write fails.
        when (action) {
            is ProviderAction.Delete -> snapshot = previous?.copy(providers = previous.providers.filterNot { it.id == action.base.id && it.machineId == machineId })
            is ProviderAction.DeleteSetup -> snapshot = previous?.copy(setups = previous.setups.filterNot { it.id == action.setup.id && it.machineId == machineId })
            else -> Unit
        }
        try {
            val result = service.perform(scope, action)
            authRequired = result.authRequired
            merge(result, machineId)
            live = true
            return true
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            snapshot = previous
            live = false
            error = (failure as? app.lody.android.runtime.RuntimeException)?.fault?.code ?: "provider_write_unknown"
            return false
        } finally { busy = false; operations.unlock() }
    }
    private fun merge(result: AgentProviders, machineId: String?) {
        snapshot = if (machineId == null) result else {
            val retained = result.machines.map { it.id }.toSet() - machineId
            result.copy(
                providers = snapshot?.providers.orEmpty().filter { it.machineId in retained } + result.providers.filter { it.machineId == machineId },
                setups = snapshot?.setups.orEmpty().filter { it.machineId in retained } + result.setups.filter { it.machineId == machineId },
            )
        }
        remembered = scope to snapshot!!.copy(authRequired = false)
    }

    private companion object {
        /** Process memory only (one scope): reopening the page shows the last list while it refreshes. */
        @Volatile var remembered: Pair<RuntimeScope, AgentProviders>? = null
    }

}
