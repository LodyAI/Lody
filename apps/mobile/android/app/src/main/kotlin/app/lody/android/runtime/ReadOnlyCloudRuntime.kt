package app.lody.android.runtime

import android.content.Context
import app.lody.android.cloud.StreamAccess
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.json.JSONArray
import org.json.JSONObject

/** Owns cloud startup and grant refresh for exactly one scope and backend generation. */
internal class ReadOnlyCloudRuntime(
    context: Context,
    override val scope: RuntimeScope,
    initialGrant: ShortLivedGrant,
    private val provider: GrantProvider,
) : CloudRuntime {
    private val access = StreamAccess(scope.workspaceId, initialGrant.gatewayBaseUrl)
    private val runtime = WebViewRuntime(scope, WebViewCloudRuntime(context, "NetworkRuntime.html", access))
    override val state = runtime.state
    private val mutableEvents = MutableSharedFlow<RuntimeEmission>()
    override val events: Flow<RuntimeEmission> = mutableEvents.asSharedFlow()
    private var lifetime: CoroutineScope? = null
    private var grantJob: Job? = null
    private var connectedGeneration = -1L
    private var firstGrant: ShortLivedGrant? = initialGrant
    private var foreground = true
    override suspend fun start() = withContext(Dispatchers.Main.immediate) {
        if (lifetime != null) return@withContext
        val tasks = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        lifetime = tasks
        tasks.launch(start = CoroutineStart.UNDISPATCHED) {
            runtime.events.collect { event ->
                if (event.generation != state.value.generation) return@collect
                if (event.event == RuntimeEvent.GrantRequested) refresh()
                else mutableEvents.emit(event)
            }
        }
        tasks.launch {
            state.map { it.phase to it.generation }.distinctUntilChanged().collect { (phase, _) ->
                grantJob?.cancel(); grantJob = null
                if (phase == RuntimePhase.READY) refresh()
            }
        }
        runtime.start()
    }
    private fun refresh() {
        if (!foreground || state.value.phase != RuntimePhase.READY || grantJob?.isActive == true) return
        val generation = state.value.generation
        grantJob = lifetime?.launch {
            var failures = 0
            while (isActive && foreground && state.value.generation == generation) {
                val began = System.nanoTime()
                try {
                    val grant = firstGrant?.also { firstGrant = null }?.takeIf { it.remainingSeconds() > 30 } ?: provider.request(scope)
                    ConnectionTrace.mark("grant_ok", (System.nanoTime() - began) / 1_000_000)
                    ensureActive()
                    if (state.value.generation != generation) return@launch
                    if (StreamAccess(scope.workspaceId, grant.gatewayBaseUrl).origin != access.origin) throw RuntimeException(RuntimeFault("grant_endpoint_changed", RuntimeErrorCategory.AUTH))
                    val payload = JSONObject().put("token", grant.token).put("gatewayBaseUrl", access.origin).put("expiresIn", grant.remainingSeconds().also { if (it <= 0) throw RuntimeException(RuntimeFault("grant_expired", RuntimeErrorCategory.AUTH)) })
                    runtime.call("grant", JSONArray().put(payload))
                    if (connectedGeneration != generation) {
                        runtime.call("connect", JSONArray().put(scope.workspaceId).put(access.origin).put(scope.accountId))
                        connectedGeneration = generation
                    }
                    return@launch
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    ConnectionTrace.mark("grant_failed", (System.nanoTime() - began) / 1_000_000)
                    if (state.value.generation != generation || !foreground) return@launch
                    val reason = (error as? RuntimeException)?.fault?.code ?: "grant_unavailable"
                    if (connectedGeneration == generation) runCatching { runtime.call("grant", JSONArray().put(JSONObject.NULL)) }
                    mutableEvents.emit(RuntimeEmission(generation, RuntimeEvent.SyncFailed(reason)))
                    if (reason in setOf("auth_expired", "account_changed", "grant_endpoint_changed")) return@launch
                    // Retry belongs to native even before JS has a watch loop. Scope/lifecycle cancels it.
                    delay(minOf(30_000L, 2_000L shl minOf(failures++, 4)))
                }
            }
        }
    }
    override suspend fun setActive(active: Boolean) = withContext(Dispatchers.Main.immediate) {
        foreground = active
        if (!active) { grantJob?.cancel(); grantJob = null }
        runtime.setActive(active)
    }
    override suspend fun execute(command: RuntimeCommand): RuntimeResult = runtime.execute(command)
    override suspend fun stop() = withContext(Dispatchers.Main.immediate) {
        lifetime?.cancel(); lifetime = null; grantJob = null; firstGrant = null
        runtime.stop()
    }
}
