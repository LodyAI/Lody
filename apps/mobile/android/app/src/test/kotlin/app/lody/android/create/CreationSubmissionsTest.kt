package app.lody.android.create

import app.lody.android.runtime.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CreationSubmissionsTest {
    private val scope = RuntimeScope("user", "workspace")
    private val request = CreateRequest("session", "turn", null, "machine", "agent", "Hello", null, false, null, null, null)

    @Test fun publishesImmediatelyAndSendsExactlyOnceWhileTransportIsPending() = runTest {
        val response = CompletableDeferred<CreationReceipt>()
        var calls = 0
        val store = CreationSubmissions(backgroundScope) { _, _ -> calls++; response.await() }
        store.submit(scope, request)
        assertEquals("sending", store.state.value["session"]!!.state)
        assertEquals("Hello", store.state.value["session"]!!.request.text)
        store.submit(scope, request)
        runCurrent()
        assertEquals(1, calls)
        response.complete(CreationReceipt("session", "accepted"))
        runCurrent()
        assertEquals("accepted", store.state.value["session"]!!.state)
        store.submit(scope, request)
        runCurrent()
        assertEquals(1, calls)
    }

    @Test fun failureKeepsTheOriginalTurnAndDoesNotReplay() = runTest {
        var calls = 0
        val store = CreationSubmissions(backgroundScope) { _, _ -> calls++; error("timeout") }
        store.submit(scope, request)
        runCurrent()
        assertEquals("unknown", store.state.value["session"]!!.state)
        assertEquals("turn", store.state.value["session"]!!.request.turnId)
        store.submit(scope, request)
        runCurrent()
        assertEquals(1, calls)
    }

    @Test fun switchingScopeRemovesDraftAndFencesThePendingWrite() = runTest {
        val response = CompletableDeferred<CreationReceipt>()
        val store = CreationSubmissions(backgroundScope) { _, _ -> response.await() }
        store.submit(scope, request)
        runCurrent()
        store.activate(RuntimeScope("other", "workspace"))
        response.complete(CreationReceipt("session", "accepted"))
        runCurrent()
        assertTrue(store.state.value.isEmpty())
    }
}
