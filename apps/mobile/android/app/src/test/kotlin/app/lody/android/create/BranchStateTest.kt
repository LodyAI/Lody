package app.lody.android.create

import org.junit.Assert.*
import org.junit.Test

class BranchStateTest {
    @Test fun cacheAppearsBeforeRefreshAndSelectionWins() {
        val cache = BranchCache(BranchPage(listOf("main", "feature"), "main"), "feature")
        val restored = BranchState().restore(cache)
        assertEquals("feature", restored.selected)
        val chosen = restored.select("main")
        val fresh = chosen.accept(BranchPage(listOf("main", "new"), "new", 2), 1)
        assertEquals("main", fresh.selected)
        assertEquals(listOf("main", "new"), fresh.page!!.names)
        assertEquals(listOf("main", "new", "later"), fresh.accept(BranchPage(listOf("new", "later")), 2).page!!.names)
    }
    @Test fun missingCacheAndEmptyRepoDoNotInventABranch() {
        assertEquals("", BranchState().restore(null).selected)
        assertEquals("", BranchState().accept(BranchPage(emptyList()), 1).selected)
        assertEquals("", BranchState().select("invented").selected)
    }
    @Test fun lateCacheCannotOverwriteCurrentSelection() {
        val state = BranchState().accept(BranchPage(listOf("main", "feature")), 1).select("feature")
        assertEquals("feature", state.restore(BranchCache(BranchPage(listOf("main")), "main")).selected)
    }
}
