package app.lody.android.chat

import app.lody.android.runtime.TurnItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnLayoutTest {
    private fun text(id: String) = TurnItem.Text(id, "text $id")
    private fun thought(id: String) = TurnItem.Thought(id, "thinking $id")
    private fun tool(id: String, kind: String = "execute", path: String? = null) = TurnItem.Tool(id, kind, "title $id", "completed", path)

    @Test fun consecutiveStepsFormOneSummarizedGroup() {
        val layout = TurnLayout.build("t", listOf(tool("1"), tool("2", "read", "a.kt"), tool("3", "read", "a.kt"), text("4")), finished = false, showThoughts = false)
        assertEquals(2, layout.blocks.size)
        val group = layout.blocks[0] as TurnLayout.Activity
        assertEquals(TurnLayout.Summary(commands = 1, reads = 1), group.summary)
        assertFalse("A streaming turn stays expanded", layout.folded)
    }

    @Test fun finishedTurnFoldsWorkAndKeepsTheContiguousAnswerRun() {
        val items = listOf(text("1"), tool("2"), text("3"), text("4"), TurnItem.ProposedPlan("5", "plan"))
        val layout = TurnLayout.build("t", items, finished = true, showThoughts = false)
        assertTrue(layout.folded)
        assertEquals(listOf("t:content:1", "t:activity:2"), layout.folding.map { it.key })
        assertEquals(listOf("t:content:3", "t:content:4", "t:content:5"), layout.visible.map { it.key })
    }

    @Test fun aTurnWithoutAnAnswerStaysExpanded() {
        val layout = TurnLayout.build("t", listOf(text("1"), tool("2")), finished = true, showThoughts = false)
        assertFalse(layout.folded)
        assertEquals(2, layout.visible.size)
    }

    @Test fun onlyDshShowsThoughtsAsTheirOwnOpenGroups() {
        val items = listOf(thought("1"), tool("2"), thought("3"), text("4"))
        val hidden = TurnLayout.build("t", items, finished = false, showThoughts = false)
        assertEquals(listOf("t:activity:2", "t:content:4"), hidden.blocks.map { it.key })
        val dsh = TurnLayout.build("t", items, finished = false, showThoughts = true)
        val groups = dsh.blocks.filterIsInstance<TurnLayout.Activity>()
        assertEquals(listOf(true, false, true), groups.map { it.opensByDefault })
    }

    @Test fun thinkStepsAndPlanApprovalsAreNotGroupedSteps() {
        val layout = TurnLayout.build("t", listOf(tool("1", "think"), tool("2", "switch_mode"), text("3")), finished = true, showThoughts = false)
        assertEquals(listOf("t:content:2", "t:content:3"), layout.blocks.map { it.key })
        assertFalse("Nothing folds: the approval is never folded and the answer follows it", layout.folded)
    }

    @Test fun tasksLeaveTheTurnBlocksForTheirOwnPanel() {
        val task = TurnItem.Task("9", "Explore", "map the repo", "running")
        val layout = TurnLayout.build("t", listOf(tool("1"), text("2"), task), finished = true, showThoughts = false)
        assertEquals(listOf(task), layout.tasks)
        assertEquals(listOf("t:content:2"), layout.visible.map { it.key })
        assertTrue("The answer still ends the turn, so the work folds", layout.folded)
    }
}
