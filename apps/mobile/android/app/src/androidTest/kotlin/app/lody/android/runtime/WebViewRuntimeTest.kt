package app.lody.android.runtime

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lody.android.diagnostics.RuntimeDiagnostics
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class WebViewRuntimeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)
    private fun waitFor(runtime: RuntimeBackend, predicate: (RuntimeStatus) -> Boolean) {
        val latch = CountDownLatch(1)
        lateinit var subscription: AutoCloseable
        main { subscription = runtime.observe { if (predicate(it)) latch.countDown() } }
        try { assertTrue("Runtime readiness timed out: ${runtime.status}", latch.await(35, TimeUnit.SECONDS)) }
        finally { main { subscription.close() } }
    }
    private fun withRuntime(block: (RuntimeDiagnostics) -> Unit) {
        lateinit var diagnostics: RuntimeDiagnostics
        main { diagnostics = RuntimeDiagnostics(instrumentation.targetContext); diagnostics.runtime.start() }
        try { waitFor(diagnostics.runtime) { it.phase == RuntimePhase.READY }; block(diagnostics) }
        finally { main { diagnostics.runtime.stop() } }
    }
    @Test fun bundledProductionRuntimeAndRealWasmRoundTripsWork() = withRuntime { diagnostics ->
        val latch=CountDownLatch(1)
        var rows: List<app.lody.android.diagnostics.CapabilityCheck>? = null
        main { diagnostics.check { rows=it.getOrNull(); latch.countDown() } }
        assertTrue(latch.await(15,TimeUnit.SECONDS))
        assertEquals(7,rows?.size)
        assertTrue(rows.toString(), rows!!.all { it.passed })
    }
    @Test fun concurrentBridgeCallsPreserveUnicodeAndRequestIdentity() = withRuntime { diagnostics ->
        val latch=CountDownLatch(8)
        val received=java.util.concurrent.ConcurrentHashMap<Int,String>()
        main { repeat(8) { i -> diagnostics.runtime.request("echo",JSONArray().put("$i 中文 \" \n </script>")) { received[i]=it.getOrNull().toString(); latch.countDown() } } }
        assertTrue(latch.await(10,TimeUnit.SECONDS))
        repeat(8) { i -> assertEquals("$i 中文 \" \n </script>",received[i]) }
    }
    @Test fun stopCancelsPendingAndOldGenerationNeverCompletesAgain() = withRuntime { diagnostics ->
        val callbacks=AtomicInteger()
        var error: String?=null
        val runtime=diagnostics.runtime
        main {
            runtime.request("delay",JSONArray().put(1500)) { callbacks.incrementAndGet(); error=it.exceptionOrNull()?.message }
            runtime.stop()
            runtime.start()
        }
        waitFor(runtime) { it.phase==RuntimePhase.READY }
        assertEquals("runtime_stopped",error)
        Thread.sleep(1800) // Intentionally cross the old reply's deadline.
        assertEquals(1,callbacks.get())
    }
    @Test fun backgroundRetainsWebViewAndResetsHeartbeatDeadline() = withRuntime { diagnostics ->
        val runtime=diagnostics.runtime
        var generation=0L
        main { generation=runtime.status.generation; runtime.setActive(false) }
        Thread.sleep(9000) // Cross the 8s heartbeat deadline while suspended.
        main { assertEquals(RuntimePhase.SUSPENDED,runtime.status.phase); runtime.setActive(true) }
        waitFor(runtime) { it.phase==RuntimePhase.READY && it.acknowledgements>0 }
        main { assertEquals(generation,runtime.status.generation); assertEquals(0,runtime.status.automaticRestarts) }
    }
    @Test fun catalogAlreadyPostedAtSuspensionKeepsItsRevisionPairWithoutRebuilding() = withRuntime { diagnostics ->
        val runtime = diagnostics.runtime
        val received = java.util.concurrent.CopyOnWriteArrayList<RuntimeEmission>()
        val latch = CountDownLatch(2)
        lateinit var subscription: AutoCloseable
        var generation = 0L
        main {
            generation = runtime.status.generation
            subscription = runtime.observeEvents { received.add(it); latch.countDown() }
            val catalog = org.json.JSONObject().put("type", "catalog").put("revision", 1)
                .put("catalog", """{"projects":[],"sessions":[],"machineIds":[]}""")
            runtime.request("event", JSONArray().put(catalog)) {}
            runtime.request("event", JSONArray().put(org.json.JSONObject().put("type", "synced").put("revision", 1).put("streams", 1))) {}
            // Bridge callbacks run on this same executor, after suspension is applied.
            runtime.setActive(false)
        }
        try {
            assertTrue("Catalog pair was dropped during suspension", latch.await(10, TimeUnit.SECONDS))
            assertEquals(listOf(generation, generation), received.map { it.generation })
            assertTrue(received[0].event is RuntimeEvent.CatalogUpdated)
            assertTrue(received[1].event is RuntimeEvent.Synced)
            main { assertEquals(RuntimePhase.SUSPENDED, runtime.status.phase); runtime.setActive(true) }
            waitFor(runtime) { it.phase == RuntimePhase.READY && it.acknowledgements > 0 }
            main { assertEquals(generation, runtime.status.generation); assertEquals(0, runtime.status.automaticRestarts) }
        } finally { main { subscription.close() } }
    }
    @Test fun navigationCannotEscapeTheBundledDocument() = withRuntime { diagnostics ->
        main { diagnostics.runtime.request("navigate") {} }
        waitFor(diagnostics.runtime) { it.blockedNavigations>0 }
        val latch=CountDownLatch(1)
        var alive=false
        main { diagnostics.runtime.ping { alive=it.getOrNull()==true;latch.countDown() } }
        assertTrue(latch.await(10,TimeUnit.SECONDS));assertTrue(alive)
    }
    @Test fun nativeWatchdogRecoversWhenJavascriptStopsResponding() = withRuntime { diagnostics ->
        main { diagnostics.stall {} }
        waitFor(diagnostics.runtime) { it.automaticRestarts==1 && it.phase==RuntimePhase.READY }
        main { assertEquals("watchdog_timeout", diagnostics.runtime.status.recoveryReason) }
    }
    @Test fun pendingCommandsHaveNativeTimeouts() = withRuntime { diagnostics ->
        val latch=CountDownLatch(1)
        var error: String?=null
        main { diagnostics.runtime.request("delay",JSONArray().put(10000)) { error=it.exceptionOrNull()?.message; latch.countDown() } }
        assertTrue(latch.await(8,TimeUnit.SECONDS))
        assertEquals("command_timeout",error)
    }
    @Test fun missingAssetFailsAfterBoundedRecovery() {
        lateinit var runtime: WebViewCloudRuntime
        main { runtime=WebViewCloudRuntime(instrumentation.targetContext,"Missing.html"); runtime.start() }
        try {
            waitFor(runtime) { it.phase==RuntimePhase.FAILED }
            main { assertEquals(3,runtime.status.automaticRestarts); assertNotNull(runtime.status.failure) }
        } finally { main { runtime.stop() } }
    }

}
