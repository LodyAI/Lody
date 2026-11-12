package app.lody.android.runtime

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Account/workspace lease. All mutations run on the injected platform executor. */
class RuntimeOwner(private val factory: (RuntimeScope) -> CloudRuntime, private val dispatcher: CoroutineDispatcher, private val admit: (RuntimeScope) -> Unit = {}) {
    private class Lease(val runtime: CloudRuntime, val job: CompletableJob, val tasks: CoroutineScope)
    private var current: Lease? = null
    private var active = true
    private val mutex = Mutex()
    private val mutableState = MutableStateFlow(OwnedRuntimeState())
    val state: StateFlow<OwnedRuntimeState> = mutableState.asStateFlow()
    private val mutableEvents = MutableSharedFlow<ScopedRuntimeEvent>()
    val events: Flow<ScopedRuntimeEvent> = mutableEvents.asSharedFlow()
    suspend fun activate(scope: RuntimeScope) = withContext(dispatcher) {
        mutex.withLock {
            admit(scope)
            if (current?.runtime?.scope == scope) return@withLock
            withContext(NonCancellable) { release() }
            val runtime = factory(scope)
            val job = SupervisorJob()
            val lease = Lease(runtime, job, CoroutineScope(dispatcher + job))
            current = lease
            mutableState.value = OwnedRuntimeState(scope, runtime.state.value)
            lease.tasks.launch { runtime.state.collect { if (current === lease) mutableState.value = OwnedRuntimeState(scope, it) } }
            lease.tasks.launch { runtime.events.collect { if (current === lease && it.generation == runtime.state.value.generation) mutableEvents.emit(ScopedRuntimeEvent(scope, it.event, it.generation)) } }
            try { runtime.setActive(active); runtime.start() }
            catch (error: Throwable) { withContext(NonCancellable) { release() }; throw error }
        }
    }
    private suspend fun release() {
        val old = current
        current = null
        mutableState.value = OwnedRuntimeState()
        old?.job?.cancel()
        old?.runtime?.stop()
    }
    suspend fun clear() = withContext(dispatcher) { mutex.withLock { withContext(NonCancellable) { release() } } }
    suspend fun setActive(active: Boolean) = withContext(dispatcher) {
        mutex.withLock { this@RuntimeOwner.active = active; current?.runtime?.setActive(active) }
    }
    suspend fun <T> use(scope: RuntimeScope, block: suspend (CloudRuntime) -> T): T = withContext(dispatcher) {
        admit(scope)
        val lease = current?.takeIf { it.runtime.scope == scope } ?: throw scopeChanged()
        val task = lease.tasks.async { block(lease.runtime) }
        try {
            val result = task.await()
            if (current !== lease) throw scopeChanged()
            result
        } finally { task.cancel() }
    }
    private fun scopeChanged() = RuntimeException(RuntimeFault("scope_changed", RuntimeErrorCategory.CANCELLED))
}
