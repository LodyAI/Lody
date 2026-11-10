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
    suspend fun operation(scope: RuntimeScope, machineId: String, id: String?, action: String, cliType: String? = null, agentType: String? = null): ProviderOperation = error("provider_operation_unavailable")
    suspend fun auth(scope: RuntimeScope, request: ProviderAuthRequest): ProviderAuthState = error("provider_auth_unavailable")
    suspend fun perform(scope: RuntimeScope, action: ProviderAction): AgentProviders
}
class RuntimeAgentProviderService(private val owner: RuntimeOwner) : AgentProviderService {
    override fun changes(scope: RuntimeScope): Flow<String> = owner.events.filter { it.scope == scope }.mapNotNull { (it.event as? RuntimeEvent.ProvidersChanged)?.machineId }
    override fun progress(scope: RuntimeScope): Flow<RuntimeEvent.ProviderProgress> = owner.events.filter { it.scope == scope }.mapNotNull { it.event as? RuntimeEvent.ProviderProgress }
    override suspend fun detail(scope: RuntimeScope, machineId: String, id: String) = owner.use(scope) { (it.execute(RuntimeCommand.ProviderDetail(machineId, id)) as RuntimeResult.ProviderDetail).value }
    override suspend fun probe(scope: RuntimeScope, machineId: String, id: String) = owner.use(scope) { (it.execute(RuntimeCommand.ProviderProbe(machineId, id)) as RuntimeResult.ProviderProbe).value }
    override suspend fun operation(scope: RuntimeScope, machineId: String, id: String?, action: String, cliType: String?, agentType: String?) = owner.use(scope) { (it.execute(RuntimeCommand.ProviderOperation(machineId, id, action, cliType, agentType)) as RuntimeResult.ProviderOperation).value }
    override suspend fun auth(scope: RuntimeScope, request: ProviderAuthRequest) = owner.use(scope) { (it.execute(RuntimeCommand.ProviderAuth(request)) as RuntimeResult.ProviderAuth).value }
    override suspend fun perform(scope: RuntimeScope, action: ProviderAction): AgentProviders = owner.use(scope) {
        (it.execute(RuntimeCommand.AgentProviders(action)) as RuntimeResult.AgentProviders).value
    }
}

/** One screen/scope owns reads; writes are never replayed, and stale display never grants editing. */
internal class AgentSettingsState(private val service: AgentProviderService, private val scope: RuntimeScope) {
    private val operations = Mutex()
    var snapshot by mutableStateOf<AgentProviders?>(null); private set
    var busy by mutableStateOf(false); private set
    var live by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var authRequired by mutableStateOf(false); private set
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
        try {
            val result = service.perform(scope, action)
            authRequired = result.authRequired
            merge(result, machineId)
            live = true
            return true
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            live = false
            error = (failure as? app.lody.android.runtime.RuntimeException)?.fault?.code ?: "provider_write_unknown"
            return false
        } finally { busy = false; operations.unlock() }
    }
    private fun merge(result: AgentProviders, machineId: String?) {
        if (machineId == null) { snapshot = result; return }
        val retained = result.machines.map { it.id }.toSet() - machineId
        snapshot = result.copy(
            providers = snapshot?.providers.orEmpty().filter { it.machineId in retained } + result.providers.filter { it.machineId == machineId },
            setups = snapshot?.setups.orEmpty().filter { it.machineId in retained } + result.setups.filter { it.machineId == machineId },
        )
    }

}
