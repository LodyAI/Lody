package app.lody.android.chat

import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lody.android.designsystem.LodyTheme
import app.lody.android.diagnostics.CreateSessionProbeActivity
import app.lody.android.runtime.TurnItem
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MessageActionsTest {
 @Test fun actionsTargetTheirOwnMessageAndOnlyLastUserCanEdit() {
  val edited = AtomicInteger(); val info = AtomicInteger(); val fork = AtomicInteger()
  ActivityScenario.launch(CreateSessionProbeActivity::class.java).use { scenario ->
   scenario.onActivity { activity -> activity.setContent { LodyTheme {
    ChatTranscript(listOf(
     ChatEntry.User("old", "Older prompt", TurnIdentity("You")),
     ChatEntry.User("last", "Latest prompt", TurnIdentity("You")),
     ChatEntry.Assistant("reply", TurnLayout.build("reply", listOf(TurnItem.Text("text", "Answer to copy")), true, false), emptyMap(), TurnIdentity("Codex")),
    ), actions = MessageActionState("last", { if(it=="last") edited.incrementAndGet() }, { if(it=="reply") info.incrementAndGet() }, { if(it=="reply") fork.incrementAndGet() }))
   } } }
   SystemClock.sleep(700)
   fun nodes(label: String): List<AccessibilityNodeInfo> {
    val result = mutableListOf<AccessibilityNodeInfo>()
    fun visit(n: AccessibilityNodeInfo) { if(n.contentDescription?.toString()==label) result += n; for(i in 0 until n.childCount) n.getChild(i)?.let(::visit) }
    InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow?.let(::visit)
    return result
   }
   fun tap(label: String) {
    var node = nodes(label).single()
    while(!node.isClickable && node.parent != null) node=node.parent
    assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_CLICK)); SystemClock.sleep(120)
   }
   val deadline = SystemClock.uptimeMillis() + 5000
   while (nodes("Edit message").isEmpty() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
   assertEquals(1, nodes("Edit message").size)
   assertEquals(3, nodes("Copy message").size)
   tap("Edit message"); tap("Conversation information"); tap("Fork conversation")
   assertEquals(1,edited.get()); assertEquals(1,info.get()); assertEquals(1,fork.get())
   var copy=nodes("Copy message").last()
   while(!copy.isClickable && copy.parent != null) copy=copy.parent
   assertTrue(copy.performAction(AccessibilityNodeInfo.ACTION_CLICK))
   SystemClock.sleep(150)
   assertEquals(1,nodes("Copied").size)
  }
 }
}
