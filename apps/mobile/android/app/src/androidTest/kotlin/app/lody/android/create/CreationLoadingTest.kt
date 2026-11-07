package app.lody.android.create

import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.lody.android.designsystem.LodyTheme
import app.lody.android.diagnostics.CreateSessionProbeActivity
import app.lody.android.runtime.*
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** Real Compose page with a controlled runtime boundary; no account or Cloud requests. */
class CreationLoadingTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun options(name: String) = CreationOptions(
        listOf(CreationAgent("agent", name, "machine", "builtin", "fixture")), emptyList(),
    )
    private fun contains(node: AccessibilityNodeInfo?, text: String): Boolean {
        if (node == null) return false
        if (node.text?.toString()?.contains(text) == true || node.contentDescription?.toString()?.contains(text) == true) return true
        return (0 until node.childCount).any { contains(node.getChild(it), text) }
    }
    private fun awaitText(text: String) {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (contains(instrumentation.uiAutomation.rootInActiveWindow, text)) return
            SystemClock.sleep(50)
        }
        fail("Missing UI text: $text")
    }

    @Test fun cachedOptionsThenOneCompleteResponseWithoutPolling() = verifyLoad(fail = false)
    @Test fun failedRequestKeepsCachedOptionsWithoutPolling() = verifyLoad(fail = true)

    private fun verifyLoad(fail: Boolean) {
        val calls = AtomicInteger()
        val response = CompletableDeferred<Unit>()
        val service = object : CreationService {
            override suspend fun cachedOptions(scope: RuntimeScope, projectId: String?): CreationOptions {
                assertNull("Cache is workspace-wide", projectId)
                return options("Cached assistant")
            }
            override suspend fun options(scope: RuntimeScope, projectId: String?): CreationOptions {
                assertNull("One request includes all machines", projectId)
                calls.incrementAndGet()
                response.await()
                check(!fail) { "offline fixture" }
                return options("Refreshed assistant")
            }
            override suspend fun create(scope: RuntimeScope, request: CreateRequest): CreationReceipt = error("No send expected")
        }
        ActivityScenario.launch(CreateSessionProbeActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    LodyTheme {
                        CreateSessionScreen(
                            CatalogSnapshot(1, emptyList(), emptyList(), listOf("machine")), service,
                            RuntimeScope("fixture", "workspace"), onSubmit = {}, onBack = {},
                        )
                    }
                }
            }
            awaitText("Cached assistant")
            response.complete(Unit)
            if (!fail) awaitText("Refreshed assistant")
            // Cross the old five-second interval; neither success nor failure starts another read.
            SystemClock.sleep(6_000)
            awaitText(if (fail) "Cached assistant" else "Refreshed assistant")
            assertEquals("Creation performs exactly one complete read", 1, calls.get())
        }
    }
}
