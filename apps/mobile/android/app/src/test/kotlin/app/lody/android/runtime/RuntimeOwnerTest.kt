package app.lody.android.runtime
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RuntimeOwnerTest {
    private val a=RuntimeScope("account-a","workspace-a")
    private val b=RuntimeScope("account-b","workspace-a")
    private class Fake(override val scope: RuntimeScope): CloudRuntime {
        val mutable=MutableStateFlow(RuntimeStatus())
        override val state: StateFlow<RuntimeStatus> = mutable
        val emitted=MutableSharedFlow<RuntimeEmission>(extraBufferCapacity=8)
        override val events: Flow<RuntimeEmission> = emitted
        var starts=0;var stops=0;var active=true
        override suspend fun start() { starts++;mutable.value=RuntimeStatus(phase=RuntimePhase.READY,generation=1) }
        override suspend fun stop() { stops++;mutable.value=RuntimeStatus(phase=RuntimePhase.STOPPED) }
        override suspend fun setActive(active: Boolean) { this.active=active }
        override suspend fun execute(command: RuntimeCommand): RuntimeResult = RuntimeResult.Pong(true)
    }
    @Test fun repeatedActivationRetainsTheRuntimeAndBackgroundState() = runTest {
        val instances=mutableListOf<Fake>()
        val owner=RuntimeOwner({ Fake(it).also(instances::add) },StandardTestDispatcher(testScheduler))
        owner.setActive(false);owner.activate(a);owner.activate(a);runCurrent()
        assertEquals(1,instances.size);assertFalse(instances.single().active)
        assertEquals(a,owner.state.value.scope)
        owner.clear()
    }
    @Test fun changingAccountCancelsInFlightWorkAndStopsOldRuntime() = runTest {
        val instances=mutableListOf<Fake>()
        val owner=RuntimeOwner({ Fake(it).also(instances::add) },StandardTestDispatcher(testScheduler))
        owner.activate(a)
        val started=CompletableDeferred<Unit>()
        val request=async { owner.use(a) { started.complete(Unit);awaitCancellation() } }
        started.await();owner.activate(b);runCurrent()
        assertTrue(request.isCancelled);assertEquals(1,instances.first().stops)
        assertEquals(b,owner.state.value.scope)
        owner.clear()
    }
    @Test fun staleEventsAndWrongScopeCannotReachTheNewConsumer() = runTest {
        val instances=mutableListOf<Fake>();val delivered=mutableListOf<ScopedRuntimeEvent>()
        val owner=RuntimeOwner({ Fake(it).also(instances::add) },StandardTestDispatcher(testScheduler))
        val collector=backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {owner.events.toList(delivered)}
        owner.activate(a);runCurrent();owner.activate(b);runCurrent()
        instances.first().emitted.emit(RuntimeEvent.Synced(99,1))
        instances.last().emitted.emit(RuntimeEvent.Synced(2,1));runCurrent()
        assertEquals(listOf(ScopedRuntimeEvent(b,RuntimeEvent.Synced(2,1),1)),delivered)
        var rejected=false
        try {owner.use(a){it.execute(RuntimeCommand.Ping)}} catch(e:RuntimeException){rejected=e.fault.code=="scope_changed"}
        assertTrue(rejected);collector.cancel();owner.clear()
    }
    @Test fun cancellationOfCallerCancelsItsOperationWithoutStoppingOwner() = runTest {
        val fake=Fake(a);val owner=RuntimeOwner({fake},StandardTestDispatcher(testScheduler))
        owner.activate(a);val started=CompletableDeferred<Unit>();val finished=CompletableDeferred<Unit>()
        val request=launch {owner.use(a){started.complete(Unit);try {awaitCancellation()} finally {finished.complete(Unit)}}}
        started.await();request.cancelAndJoin();finished.await()
        assertEquals(0,fake.stops);assertEquals(RuntimeResult.Pong(true),owner.use(a){it.execute(RuntimeCommand.Ping)})
        owner.clear()
    }
 private suspend fun MutableSharedFlow<RuntimeEmission>.emit(event: RuntimeEvent) { emit(RuntimeEmission(1, event)) }

}
