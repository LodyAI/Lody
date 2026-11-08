package app.lody.android.chat

import android.graphics.Rect
import android.os.SystemClock
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.material3.Surface
import androidx.compose.material3.DropdownMenu
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lody.android.designsystem.LodyTheme
import app.lody.android.diagnostics.CreateSessionProbeActivity
import app.lody.android.runtime.CatalogSession
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ChatTabsMenuTest {
    @Test fun singleConversationKeepsCreationAndClosedRecoveryInMore() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val ui = instrumentation.uiAutomation
        val root = CatalogSession("root", "m", "p", "Current", "idle", false, false, "")
        val child = root.copy(id = "child", title = "Closed child", parentSessionId = "root", isTabClosed = true)
        val closed = mutableStateOf(listOf(child))
        val title = mutableStateOf("Current")
        fun nodes(): List<AccessibilityNodeInfo> {
            val result = mutableListOf<AccessibilityNodeInfo>()
            fun visit(node: AccessibilityNodeInfo) { result += node; for (i in 0 until node.childCount) node.getChild(i)?.let(::visit) }
            ui.rootInActiveWindow?.let(::visit)
            return result
        }
        fun find(label: String) = nodes().firstOrNull { it.text?.toString() == label || it.contentDescription?.toString() == label }
        fun change(expected: String, action: () -> Unit) {
            ui.executeAndWaitForEvent(action, { find(expected) != null }, 5000)
            instrumentation.waitForIdleSync()
        }
        fun tap(label: String, expected: String) {
            var node = requireNotNull(find(label))
            while (!node.isClickable && node.parent != null) node = node.parent
            change(expected) { assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) }
        }
        val context = instrumentation.targetContext
        val more = context.getString(app.lody.android.R.string.bar_more)
        val create = context.getString(app.lody.android.R.string.chat_new_tab)
        val history = context.getString(app.lody.android.R.string.chat_closed_tabs)
        ActivityScenario.launch(CreateSessionProbeActivity::class.java).use { scenario ->
            change(more) {
                scenario.onActivity { activity -> activity.setContent { LodyTheme { Box(Modifier.fillMaxSize()) {
                    ChatHeader(title.value, listOf(root), closed.value, "root", false, null, {}, {},
                        onNewTab = { title.value = "Created in current directory" },
                        onChangeTab = { id, isClosed -> if (id == "child" && !isClosed) { closed.value = emptyList(); title.value = "Restored child" } })
                } } } }
            }
            val tabsLabel = context.resources.getQuantityString(app.lody.android.R.plurals.chat_directory_tabs, 1, 1)
            assertNull(find(tabsLabel))
            tap(more, create)
            tap(create, "Created in current directory")
            tap(more, history)
            tap(history, "Closed child")
            tap("Closed child", "Restored child")
            assertNotNull(find("Restored child"))
        }
    }

    @Test fun swipeCloseHistoryBackAndRestore() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val ui = instrumentation.uiAutomation
        val root = CatalogSession("root", "m", "p", "Current conversation", "idle", false, false, "")
        val child = root.copy(id = "child", title = "Second conversation", parentSessionId = "root")
        val rows = mutableStateOf(listOf(root, child))
        var selected: String? = null
        ActivityScenario.launch(CreateSessionProbeActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> activity.setContent { LodyTheme { Surface { Box(Modifier.fillMaxSize().statusBarsPadding().padding(24.dp)) { DropdownMenu(expanded = true, onDismissRequest = {}, modifier = Modifier.heightIn(max = 420.dp)) {
                ChatTabsMenu(rows.value.filter { !it.isTabClosed }, rows.value.filter { it.isTabClosed }, "root", false, null,
                    onSelect = { selected = it }, onNew = {},
                    onClose = { id -> rows.value = rows.value.map { if (it.id == id) it.copy(isTabClosed = true) else it } },
                    onRestore = { id -> rows.value = rows.value.map { if (it.id == id) it.copy(isTabClosed = false) else it }; selected = id })
            } } } } } }
            fun nodes(): List<AccessibilityNodeInfo> {
                val result = mutableListOf<AccessibilityNodeInfo>()
                fun visit(node: AccessibilityNodeInfo) { result += node; for (i in 0 until node.childCount) node.getChild(i)?.let(::visit) }
                ui.rootInActiveWindow?.let(::visit); return result
            }
            fun find(text: String) = nodes().firstOrNull { it.text?.toString() == text || it.contentDescription?.toString() == text }
            fun waitFor(text: String) {
                val deadline = SystemClock.uptimeMillis() + 5000
                while (find(text) == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
                assertNotNull(text, find(text)); SystemClock.sleep(300)
            }
            fun tap(text: String) {
                var node = find(text)!!
                while (!node.isClickable && node.parent != null) node = node.parent
                assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_CLICK)); SystemClock.sleep(400)
            }
            fun screenshot(name: String) {
                val bitmap = ui.takeScreenshot()
                File(instrumentation.targetContext.cacheDir, "$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            }
            waitFor("Second conversation")
            screenshot("tabs-open")
            val bounds = Rect(); find("Second conversation")!!.getBoundsInScreen(bounds)
            val down = SystemClock.uptimeMillis()
            for (i in 0..12) {
                val action = when (i) { 0 -> MotionEvent.ACTION_DOWN; 12 -> MotionEvent.ACTION_UP; else -> MotionEvent.ACTION_MOVE }
                val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, bounds.right.toFloat() - i * 18, bounds.centerY().toFloat(), 0)
                ui.injectInputEvent(event, true); event.recycle(); SystemClock.sleep(20)
            }
            waitFor("Close"); screenshot("tabs-swipe"); tap("Close")
            assertTrue(rows.value.first { it.id == "child" }.isTabClosed)
            assertFalse(rows.value.first().isTabClosed)
            tap("Closed conversations"); waitFor("Restore conversation"); screenshot("tabs-closed")
            tap("Back"); waitFor("New Tab conversation")
            tap("Closed conversations"); waitFor("Second conversation"); tap("Second conversation")
            assertEquals("child", selected)
            assertFalse(rows.value.any { it.isTabClosed })
            waitFor("No closed conversations")
        }
    }
}
