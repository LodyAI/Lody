package app.lody.android.create

import app.lody.android.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CreationRefreshTest {
    @Test fun presenceEventRecoversUnknownOptionsWithoutTimerAndDoesNotEraseCache() = runTest {
        val scope = RuntimeScope("account", "workspace")
        val events = MutableSharedFlow<RuntimeEmission>()
        var options = CreationOptions(emptyList(), emptyList(), "unknown")
        var calls = 0
        val runtime = object : CloudRuntime {
            override val scope = scope
            override val state = MutableStateFlow(RuntimeStatus(phase = RuntimePhase.READY, generation = 1))
            override val events = events
            override suspend fun start() {}
            override suspend fun stop() {}
            override suspend fun setActive(active: Boolean) {}
            override suspend fun execute(command: RuntimeCommand): RuntimeResult { calls++; return RuntimeResult.Options(options) }
        }
        var saved: CreationOptions? = null
        val store = object : CreationOptionsStore {
            override suspend fun readOptions(scope: RuntimeScope, projectId: String?) = saved
            override suspend fun writeOptions(scope: RuntimeScope, projectId: String?, options: CreationOptions) { saved = options }
        }
        val owner = RuntimeOwner({ runtime }, StandardTestDispatcher(testScheduler))
        owner.activate(scope); runCurrent()
        val received = mutableListOf<CreationOptions?>()
        val job = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            CreateSessionRepository(owner, store).observeOptions(scope).toList(received)
        }
        advanceTimeBy(200); runCurrent()
        assertNull(saved); assertNull(received.last())
        options = CreationOptions(listOf(CreationAgent("g", "Grok", "mac", "builtin", "grok")), emptyList())
        events.emit(RuntimeEmission(1, RuntimeEvent.CreationChanged("online")))
        advanceTimeBy(200); runCurrent()
        assertEquals(options, received.last()); assertEquals(options, saved)
        val before = calls
        advanceTimeBy(10_000); runCurrent(); assertEquals(before, calls)
        job.cancelAndJoin(); owner.clear()
    }
}
