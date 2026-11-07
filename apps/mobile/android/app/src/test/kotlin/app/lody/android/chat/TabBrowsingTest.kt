package app.lody.android.chat

import app.lody.android.runtime.CatalogSession
import app.lody.android.runtime.RuntimeScope
import app.lody.android.home.ChatAttention
import org.junit.Assert.*
import org.junit.Test

class TabBrowsingTest {
    private val scope = RuntimeScope("user", "workspace")
    private val root = CatalogSession("root", "m", "p", "Root", "idle", false, false, "")
    private val child = root.copy(id = "child", parentSessionId = "root", lastMessageAt = 100)
    private val rows = listOf(root, child)
    @Test fun remembersTabAcrossInstancesAndScopes() {
        val disk = mutableMapOf<String, String>()
        val first = TabBrowsing(disk::get) { key, value -> disk[key] = value }
        first.visit(scope, child, rows)
        val restarted = TabBrowsing(disk::get) { key, value -> disk[key] = value }
        assertEquals("child", restarted.resolve(scope, root, rows))
        assertEquals("root", restarted.resolve(RuntimeScope("other", "workspace"), root, rows))
        assertEquals("root", restarted.resolve(RuntimeScope("user", "other"), root, rows))
        assertEquals("root", restarted.resolve(scope, root, listOf(root, child.copy(isTabClosed = true))))
        assertEquals("root", restarted.resolve(scope, root, listOf(root)))
        assertEquals("child", restarted.resolve(scope, child, rows))
    }
    @Test fun visitedWatermarkClearsOnlyViewedOutputAndKeepsStatus() {
        val disk = mutableMapOf<String, String>()
        val browsing = TabBrowsing(disk::get) { key, value -> disk[key] = value }
        browsing.visit(scope, child, rows)
        assertNull(DirectoryTabs.attention(listOf(browsing.viewed(scope, child))))
        assertEquals(ChatAttention.Unread, DirectoryTabs.attention(listOf(browsing.viewed(scope, child.copy(lastMessageAt = 101)))))
        assertEquals(ChatAttention.Running, DirectoryTabs.attention(listOf(browsing.viewed(scope, child.copy(status = "running")))))
        browsing.visit(scope, child.copy(lastMessageAt = 90), rows)
        assertNull(DirectoryTabs.attention(listOf(browsing.viewed(scope, child))))
    }
}
