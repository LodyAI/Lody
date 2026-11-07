package app.lody.android.chat

import app.lody.android.runtime.CatalogSession
import app.lody.android.home.ChatAttention
import org.junit.Assert.*
import org.junit.Test

class DirectoryTabsTest {
    private fun session(id: String, parent: String? = null, status: String = "idle") = CatalogSession(id, "m", "p", id, status, false, false, "2026-11-03T00:00:00Z", parentSessionId = parent)
    @Test fun tabsShareTheirOwnerNotJustProjectOrOpener() {
        val root = session("root")
        val child = session("child", "root")
        val other = session("other").copy(openedBySessionId = "root")
        val hidden = session("hidden", "root").copy(archived = true)
        assertEquals(listOf("root", "child"), DirectoryTabs.sessions(child, listOf(other, hidden, child, root)).map { it.id })
    }
    @Test fun closedRootDoesNotHideOpenChild() {
        val root = session("root").copy(isTabClosed = true)
        val child = session("child", "root")
        assertEquals(listOf("child"), DirectoryTabs.sessions(child, listOf(root, child)).map { it.id })
        assertEquals(listOf("root"), DirectoryTabs.closed(child, listOf(root, child)).map { it.id })
        assertEquals(listOf("root", "child"), DirectoryTabs.sessions(child, listOf(root.copy(isTabClosed = false), child)).map { it.id })
    }
    @Test fun attentionWinsOverRunningAndUnread() {
        assertEquals(ChatAttention.Waiting, DirectoryTabs.attention(listOf(session("running", status="running"), session("wait", status="requestPermission"))))
    }
    @Test fun missingOwnerDoesNotIncludeUnrelatedChats() {
        val child = session("child", "missing")
        assertEquals(listOf(child), DirectoryTabs.sessions(child, listOf(child, session("other"))))
    }
}
