package app.lody.android.runtime

import android.content.Intent
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewCompat
import app.lody.android.diagnostics.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimeOwnerDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val scope = RuntimeScope("device-fixture", "workspace")
    private suspend fun ready(runtime: CloudRuntime) = withTimeout(35_000) { runtime.state.first { it.phase == RuntimePhase.READY } }
    private fun runtimeTest(block: suspend (WebViewRuntime) -> Unit) = runBlocking {
        val runtime = withContext(Dispatchers.Main) { WebViewRuntime(scope, WebViewCloudRuntime(instrumentation.targetContext, "DebugRuntime.html")) }
        try { runtime.start(); ready(runtime); block(runtime) } finally { runtime.stop() }
    }
    @Test fun creationUsesTypedCommandsAcrossTheWebViewBridge() = runtimeTest { runtime ->
        val options = (runtime.execute(RuntimeCommand.GetCreationOptions(null)) as RuntimeResult.Options).value
        assertEquals("fixture-agent", options.agents.single().id)
        val request = CreateRequest(java.util.UUID.randomUUID().toString(), java.util.UUID.randomUUID().toString(), null, "fixture-machine", "fixture-agent", "中文 😀", null, false, null, null, null)
        val receipt = (runtime.execute(RuntimeCommand.CreateAndSend(request)) as RuntimeResult.Created).value
        assertEquals(request.sessionId, receipt.sessionId)
        assertEquals("accepted", receipt.state)
        try { runtime.execute(RuntimeCommand.CreateAndSend(request)); fail("Creation must not replay") }
        catch (_: RuntimeException) { }
    }
    @Test fun cancellationReleasesPendingCapacityAndDoesNotStopRuntime() = runtimeTest { runtime ->
        val calls = List(30) { CoroutineScope(currentCoroutineContext()).launch { runtime.call("delay", JSONArray().put(20_000), CommandDeadline.QUERY) } }
        delay(250)
        calls.forEach { it.cancelAndJoin() }
        withContext(Dispatchers.Main) { /* Drain cancellation cleanup posted to main. */ }
        // Refill the bridge: a ping alone would pass even if JS retained 30 cancelled jobs.
        val refilled = List(30) { CoroutineScope(currentCoroutineContext()).async { runtime.call("delay", JSONArray().put(500), CommandDeadline.QUERY) } }
        assertTrue(refilled.awaitAll().all { it == true })
        assertEquals(RuntimeResult.Pong(true), runtime.execute(RuntimeCommand.Ping))
        assertEquals(RuntimePhase.READY, runtime.state.value.phase)
    }
    @Test fun largeUnicodeMessagesAndTypedSchemaCrossTheActualBridge() = runtimeTest { runtime ->
        val value = runtime.call("large", JSONArray().put(180_000), CommandDeadline.QUERY)
        assertTrue("Large Unicode reply differs", value == "中文😀".repeat(180_000))
        assertEquals(emptySet<String>(), (runtime.execute(RuntimeCommand.InspectSchema) as RuntimeResult.Schema).machineIds)
        val event = CoroutineScope(currentCoroutineContext()).async(start = CoroutineStart.UNDISPATCHED) { withTimeout(5000) { runtime.events.first() } }
        // Upstream emits a JSON STRING in catalog, not a nested object.
        val catalog = """{"projects":[],"sessions":[],"machineIds":["machine-fixture"]}"""
        runtime.call("event", JSONArray().put(JSONObject().put("type", "catalog").put("revision", 7).put("catalog", catalog)))
        assertEquals(RuntimeEvent.CatalogUpdated(CatalogSnapshot(7, emptyList(), emptyList(), listOf("machine-fixture"))), event.await().event)
    }
    @Test fun sessionProjectionCrossesTheActualWebViewBridge() = runtimeTest { runtime ->
        val event = CoroutineScope(currentCoroutineContext()).async(start = CoroutineStart.UNDISPATCHED) {
            withTimeout(5000) { runtime.events.first { it.event is RuntimeEvent.SessionUpdated } }
        }
        val body = """{"v":1,"status":"live","entries":[{"id":"u","role":"user","finished":true,"items":[{"type":"text","text":"中文 😀"}]}]}"""
        runtime.call("event", JSONArray().put(JSONObject().put("type","session").put("sessionId","s").put("session",body)))
        assertEquals(RuntimeEvent.SessionUpdated(SessionSnapshot("s","live",listOf(SessionMessage("u","user","中文 😀",false)))), event.await().event)
    }
    @Test fun saturatedQueriesCannotStarveTheHeartbeat() = runtimeTest { runtime ->
        val generation = runtime.state.value.generation
        val results = List(32) { CoroutineScope(currentCoroutineContext()).async {
            try { runtime.call("delay", JSONArray().put(10000), CommandDeadline.QUERY); "completed" }
            catch (error: RuntimeException) { error.fault.code }
        } }.awaitAll()
        assertEquals(30, results.count { it == "completed" })
        assertEquals(2, results.count { it == "too_many_commands" })
        assertEquals(generation, runtime.state.value.generation)
        assertEquals(0, runtime.state.value.automaticRestarts)
    }
    @Test fun partialBridgeMessageSurvivesBackgroundSuspension() = runtimeTest { runtime ->
        val received = CoroutineScope(currentCoroutineContext()).async(start = CoroutineStart.UNDISPATCHED) { withTimeout(15_000) { runtime.events.first() } }
        fun chunk(index: Int, data: String) = JSONArray().put(JSONObject().put("type", "bridgeChunk").put("id", "background-fixture").put("index", index).put("total", 2).put("data", data))
        runtime.call("event", chunk(0, """{"type":"synced","revision":1,"""))
        val generation = runtime.state.value.generation
        runtime.setActive(false); delay(6000); runtime.setActive(true)
        runtime.call("event", chunk(1, """"streams":1}"""))
        assertEquals(RuntimeEvent.Synced(1,1), received.await().event)
        assertEquals(generation, runtime.state.value.generation)
    }
    @Test fun queryDeadlineAllowsWorkBeyondControlDeadline() = runtimeTest { runtime ->
        assertEquals(true, runtime.call("delay", JSONArray().put(6000), CommandDeadline.QUERY))
    }
    @Test fun rendererTerminationRecoversWithoutReplayingPendingCommands() = runtimeTest { runtime ->
        val generation = runtime.state.value.generation
        val call = CoroutineScope(currentCoroutineContext()).async {
            try { runtime.call("delay", JSONArray().put(20_000), CommandDeadline.QUERY); "unexpected_success" }
            catch (error: RuntimeException) { error.fault.code }
        }
        delay(200)
        withContext(Dispatchers.Main) {
            // Read-only test reflection keeps fault injection out of the production API.
            val field = WebViewCloudRuntime::class.java.getDeclaredField("view").apply { isAccessible = true }
            val view = field.get(runtime.backend) as WebView
            assertTrue(WebViewCompat.getWebViewRenderProcess(view)!!.terminate())
        }
        assertEquals("runtime_replaced", call.await())
        val restored = withTimeout(35_000) { runtime.state.first { it.phase == RuntimePhase.READY && it.generation > generation } }
        assertEquals(1, restored.automaticRestarts)
        assertEquals(RuntimeResult.Pong(true), runtime.execute(RuntimeCommand.Ping))
    }
    @Test fun incompatibleCapabilitiesFailClosed() = runBlocking {
        val runtime = withContext(Dispatchers.Main) { WebViewRuntime(scope, WebViewCloudRuntime(instrumentation.targetContext, "MismatchRuntime.html")) }
        try {
            runtime.start()
            val failed = withTimeout(10_000) { runtime.state.first { it.phase == RuntimePhase.FAILED } }
            assertEquals(RuntimeErrorCategory.PROTOCOL, failed.fault?.category)
            assertTrue(failed.capabilities.isEmpty())
        } finally { runtime.stop() }
    }
    @Test fun workspaceSwitchCancelsOldBridgeWorkAndBackgroundRetainsOwner() = runBlocking {
        val owner = RuntimeOwner({ key -> WebViewRuntime(key, WebViewCloudRuntime(instrumentation.targetContext, "DebugRuntime.html")) }, Dispatchers.Main.immediate)
        try {
            owner.activate(scope)
            owner.use(scope) { ready(it) }
            val started = CompletableDeferred<Unit>()
            val request = async {
                owner.use(scope) { runtime ->
                    started.complete(Unit)
                    (runtime as WebViewRuntime).call("delay", JSONArray().put(20_000), CommandDeadline.QUERY)
                }
            }
            started.await()
            val next = scope.copy(workspaceId = "workspace-next")
            owner.activate(next)
            request.join(); assertTrue(request.isCancelled)
            owner.use(next) { ready(it) }
            val generation = owner.state.value.status.generation
            owner.setActive(false); delay(9000)
            assertEquals(RuntimePhase.SUSPENDED, owner.state.value.status.phase)
            owner.setActive(true)
            owner.use(next) { ready(it); assertEquals(RuntimeResult.Pong(true), it.execute(RuntimeCommand.Ping)) }
            assertEquals(generation, owner.state.value.status.generation)
        } finally { owner.clear() }
    }
    @Test fun activityRecreationAndNavigationRetainTheApplicationRuntime() {
        val scenario = ActivityScenario.launch(RuntimeProbeActivity::class.java)
        try {
            val owner = (instrumentation.targetContext.applicationContext as DebugLodyApplication).runtimeOwner
            val before = runBlocking { withTimeout(35_000) { owner.state.first { it.status.phase == RuntimePhase.READY } } }
            var identity: CloudRuntime? = null
            runBlocking { owner.use(before.scope!!) { identity = it } }
            scenario.recreate()
            scenario.onActivity { it.startActivity(Intent(it, RuntimeDetailsActivity::class.java)) }
            instrumentation.waitForIdleSync()
            runBlocking {
                assertSame(identity, owner.use(before.scope!!) { it })
                assertEquals(before.status.generation, owner.state.value.status.generation)
            }
            instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            instrumentation.waitForIdleSync()
            runBlocking { assertSame(identity, owner.use(before.scope!!) { it }) }
        } finally { scenario.close() }
    }
}
