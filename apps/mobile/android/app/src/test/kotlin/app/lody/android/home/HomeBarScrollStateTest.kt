package app.lody.android.home

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeBarScrollStateTest {
    @Test fun collapsesOnlyAfterScrollingAndExpandsOnlyAtTop() {
        val state = HomeBarScrollState()
        state.update(-40f, true, 24f)
        assertFalse(state.collapsed)
        state.update(12f, true, 24f)
        assertFalse(state.collapsed)
        state.update(100f, false, 24f)
        assertFalse(state.collapsed)
        state.update(100f, true, 24f)
        assertTrue(state.collapsed)
        state.update(10f, true, 24f)
        assertTrue(state.collapsed)
        state.update(0f, false, 24f)
        assertFalse(state.collapsed)
    }

    @Test fun tapExpandsTheCompactBarUntilTheNextScroll() {
        val state = HomeBarScrollState()
        state.update(100f, true, 24f)
        assertTrue(state.collapsed)
        state.expand()
        assertFalse(state.collapsed)
        state.update(100f, false, 24f)
        assertFalse(state.collapsed)
        state.update(140f, true, 24f)
        assertTrue(state.collapsed)
    }
}
