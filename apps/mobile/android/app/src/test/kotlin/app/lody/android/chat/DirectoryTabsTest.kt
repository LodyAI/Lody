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
    @Test fun relationTreeKeepsOpenedConversationsSeparateFromTabs() {
        val root = session("root")
        val tab = session("tab", "root")
        val child = session("child").copy(openedBySessionId = "tab", openedByRootSessionId = "root")
        val closed = session("closed", "root").copy(isTabClosed = true)
        val all = listOf(child, tab, root, closed, session("unrelated"))
        val rows = SessionRelations.rows("child", all)
        assertEquals(listOf("root", "child"), rows.map { it.session.id })
        assertEquals(listOf(0, 1), rows.map { it.depth })
        assertEquals(listOf("tab"), rows[0].tabs.map { it.id })
        assertTrue(rows[1].tabs.isEmpty())
        assertEquals("tab", SessionRelations.target(rows[0].tabs.single().id, all)?.id)
        assertTrue(SessionRelations.rows("root", listOf(root, tab)).isEmpty())
        assertEquals(listOf("closed", "tab"), SessionRelations.rows("closed", all).first().tabs.map { it.id })
    }
    @Test fun childTabsStayOnTheirConversationRowAndOnlyOpenedEdgesIncreaseDepth() {
        val root = session("root")
        val tabs = listOf(session("a", "root"), session("b", "root"))
        val child = session("child").copy(openedBySessionId = "b")
        val childTab = session("child-tab", "child").copy(openedBySessionId = "a")
        val grandchild = session("grandchild").copy(openedBySessionId = "child-tab")
        val all = listOf(grandchild, childTab, child, root) + tabs
        val rows = SessionRelations.rows("child-tab", all)
        assertEquals(listOf("root", "child", "grandchild"), rows.map { it.session.id })
        assertEquals(listOf(0, 1, 2), rows.map { it.depth })
        assertEquals(listOf(listOf("a", "b"), listOf("child-tab"), emptyList<String>()), rows.map { row -> row.tabs.map { it.id } })
        assertEquals("child-tab", SessionRelations.target(rows[1].tabs.single().id, all)?.id)
    }
    @Test fun relationNavigationRequiresExactTargetAndContainingRoot() {
        val orphan = session("tab", "missing")
        val child = session("child").copy(openedBySessionId = "missing", openedByRootSessionId = "root")
        val root = session("root")
        assertNull(SessionRelations.target("tab", listOf(orphan)))
        assertNull(SessionRelations.target("missing", listOf(root, child)))
        assertTrue(SessionRelations.rows("child", listOf(root, child)).isEmpty())
        assertNull(SessionRelations.target("tab", listOf(orphan.copy(parentSessionId = "root"), root.copy(archived = true))))
        val cycle = listOf(session("a", "b"), session("b", "a"))
        assertNull(SessionRelations.target("a", cycle))
        assertTrue(SessionRelations.rows("a", cycle).isEmpty())
        val provenanceCycle = listOf(session("a").copy(openedBySessionId = "b"), session("b").copy(openedBySessionId = "a"))
        assertEquals(2, SessionRelations.rows("a", provenanceCycle).map { it.session.id }.distinct().size)
    }
}
