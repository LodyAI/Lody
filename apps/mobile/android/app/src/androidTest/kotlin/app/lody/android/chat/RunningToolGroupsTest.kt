package app.lody.android.chat

import android.graphics.Rect
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lody.android.designsystem.LodyTheme
import app.lody.android.diagnostics.CreateSessionProbeActivity
import app.lody.android.runtime.TurnItem
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RunningToolGroupsTest {
    @Test fun runningToolsStayCollapsedAndExpandedCommandsUseOneLine() {
        val command = "unique-command " + "long-command-argument ".repeat(30)
        ActivityScenario.launch(CreateSessionProbeActivity::class.java).use { scenario ->
            var density = 1f
            scenario.onActivity { activity ->
                density = activity.resources.displayMetrics.density
                activity.setContent { LodyTheme {
                    ChatTranscript(listOf(ChatEntry.Assistant(
                        "running", TurnLayout.build("running", listOf(
                            TurnItem.Tool("cmd", "execute", command, "in_progress", null),
                            TurnItem.Tool("read", "read", "Read sample.kt", "completed", "sample.kt"),
                        ), finished = false, showThoughts = false), emptyMap(), TurnIdentity("Agent"), working = true,
                    )))
                } }
            }
            fun nodes(): List<AccessibilityNodeInfo> {
                val found = mutableListOf<AccessibilityNodeInfo>()
                fun visit(node: AccessibilityNodeInfo) {
                    found += node
                    for (i in 0 until node.childCount) node.getChild(i)?.let(::visit)
                }
                InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow?.let(::visit)
                return found
            }
            fun summary() = nodes().firstOrNull { it.text?.toString()?.contains("1 file") == true }
            val deadline = SystemClock.uptimeMillis() + 5000
            while (summary() == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
            assertNotNull("Activity summary is visible", summary())
            assertFalse("Running commands must start folded", nodes().any { it.text?.contains("unique-command") == true })
            fun toggle() {
                var node = summary()!!
                while (!node.isClickable && node.parent != null) node = node.parent
                assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                SystemClock.sleep(500)
            }
            toggle()
            val step = nodes().first { it.text?.contains("unique-command") == true }
            val bounds = Rect(); step.getBoundsInScreen(bounds)
            assertTrue("Command label must occupy one line: $bounds", bounds.height() <= 26 * density)
            toggle()
            assertFalse(nodes().any { it.text?.contains("unique-command") == true })
        }
    }
}
