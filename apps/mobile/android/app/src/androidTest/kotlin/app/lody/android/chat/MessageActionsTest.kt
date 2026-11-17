package app.lody.android.chat

import android.content.ClipboardManager
import android.content.Context
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import app.lody.android.runtime.TurnItem
import androidx.compose.runtime.mutableStateOf
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lody.android.designsystem.LodyTheme
import app.lody.android.diagnostics.CreateSessionProbeActivity
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MessageActionsTest {
    @Test fun userActionsRequireLongPressAndOnlyLatestEligibleMessageCanEdit() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val automation = instrumentation.uiAutomation
        val edited = mutableStateOf<String?>(null)
        fun nodes(label: String): List<AccessibilityNodeInfo> {
            val result = mutableListOf<AccessibilityNodeInfo>()
            fun visit(node: AccessibilityNodeInfo) {
                if (node.contentDescription?.toString() == label || node.text?.toString() == label) result += node
                for (i in 0 until node.childCount) node.getChild(i)?.let(::visit)
            }
            automation.rootInActiveWindow?.let(::visit)
            return result
        }
        fun changed(action: () -> Unit) {
            automation.executeAndWaitForEvent(action, { true }, 5000).recycle()
            instrumentation.waitForIdleSync()
        }
        fun act(label: String, action: Int) {
            var node = nodes(label).let { matches -> matches.firstOrNull { it.text?.toString() == label } ?: matches.single() }
            while (!(if (action == AccessibilityNodeInfo.ACTION_LONG_CLICK) node.isLongClickable else node.isClickable) && node.parent != null) node = node.parent
            changed { assertTrue(node.performAction(action)) }
        }
        ActivityScenario.launch(CreateSessionProbeActivity::class.java).use { scenario ->
            changed {
                scenario.onActivity { activity -> activity.setContent { LodyTheme {
                    Column {
                    if (edited.value != null) Text(edited.value!!)
                    ChatTranscript(
                        listOf(
                            ChatEntry.User("old", "Older prompt", TurnIdentity("You")),
                            ChatEntry.User("last", "Latest prompt", TurnIdentity("You")),
                            ChatEntry.Assistant("reply", TurnLayout.build("reply", listOf(TurnItem.Text("answer", "Answer to copy")), true, false), emptyMap(), TurnIdentity("Codex")),
                        ),
                        actions = MessageActionState(editable = "last", edit = { edited.value = "Editing $it" }, info = { edited.value = "Information $it" }, fork = { edited.value = "Forking $it" }),
                    )
                    }
                } } }
            }
            assertTrue(nodes("Edit message").isEmpty())
            assertEquals(1, nodes("Copy message").size)
            act("Copy message", AccessibilityNodeInfo.ACTION_CLICK)
            scenario.onActivity { activity ->
                val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                assertEquals("Answer to copy", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
            }
            act("Conversation information", AccessibilityNodeInfo.ACTION_CLICK)
            assertEquals(1, nodes("Information reply").size)
            act("Fork conversation", AccessibilityNodeInfo.ACTION_CLICK)
            assertEquals(1, nodes("Forking reply").size)
            act("Older prompt", AccessibilityNodeInfo.ACTION_LONG_CLICK)
            assertTrue(nodes("Edit message").isEmpty())
            act("Copy message", AccessibilityNodeInfo.ACTION_CLICK)
            scenario.onActivity { activity ->
                val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                assertEquals("Older prompt", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
            }
            act("Latest prompt", AccessibilityNodeInfo.ACTION_LONG_CLICK)
            act("Edit message", AccessibilityNodeInfo.ACTION_CLICK)
            assertEquals(1, nodes("Editing last").size)
        }
    }
}
