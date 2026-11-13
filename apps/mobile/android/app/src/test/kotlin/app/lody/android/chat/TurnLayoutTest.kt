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

    @Test fun finalActivityIgnoresHiddenThinkTailAndTaskBookkeeping() {
        val task = TurnItem.Task("task", "Explore", "map the repo", "running")
        val layout = TurnLayout.build("t", listOf(tool("1"), tool("2"), thought("3"), tool("4", "think"), task), finished = false, showThoughts = false)
        assertEquals(listOf("t:activity:1"), layout.visible.map { it.key })
        assertEquals(2, (layout.visible.single() as TurnLayout.Activity).summary.commands)
        assertEquals("t:activity:1", layout.activeActivityKey(working = true))
        assertEquals(null, layout.activeActivityKey(working = false))
        assertEquals(listOf(task), layout.tasks)
    }

    @Test fun laterVisibleContentStopsHistoricalActivityShimmer() {
        val tails = listOf(text("3"), TurnItem.ProposedPlan("3", "plan"), tool("3", "switch_mode"))
        for (tail in tails) {
            val layout = TurnLayout.build("t", listOf(tool("1"), tool("2"), tail, tool("4", "think")), finished = false, showThoughts = false)
            assertEquals(null, layout.activeActivityKey(working = true))
        }
        val next = TurnLayout.build("t", listOf(tool("1"), text("2"), tool("3")), finished = false, showThoughts = false)
        assertEquals("t:activity:3", next.activeActivityKey(working = true))
        val dsh = TurnLayout.build("t", listOf(tool("1"), thought("2"), tool("3", "think")), finished = false, showThoughts = true)
        assertEquals("t:activity:2", dsh.activeActivityKey(working = true))
    }

    @Test fun imagesSeparatedOnlyByToolWorkFanIntoOneStack() {
        fun image(id: String) = app.lody.android.runtime.TurnImage(id, "$id.png", null, 600, 400)
        val items = listOf(
            tool("1"), TurnItem.Images("2", listOf(image("a"))), tool("3"), TurnItem.Images("4", listOf(image("b"), image("c"))),
            text("5"), TurnItem.Images("6", listOf(image("d"))),
        )
        val running = TurnLayout.build("t", items, finished = false, showThoughts = false)
        assertEquals(listOf("t:activity:1", "t:content:2", "t:activity:3", "t:content:5", "t:content:6"), running.blocks.map { it.key })
        val stack = (running.blocks[1] as TurnLayout.Content).item as TurnItem.Images
        assertEquals(listOf("a", "b", "c"), stack.images.map { it.id })
        // Prose ends a stack: the later image keeps its own block.
        assertEquals(listOf("d"), ((running.blocks[4] as TurnLayout.Content).item as TurnItem.Images).images.map { it.id })
        // A finished turn folds the work but never the images.
        val finished = TurnLayout.build("t", items, finished = true, showThoughts = false)
        assertEquals(listOf("t:content:2", "t:content:5", "t:content:6"), finished.visible.map { it.key })
    }

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

    @Test fun onlyDshShowsThoughtsAsSeparateGroups() {
        val items = listOf(thought("1"), tool("2"), thought("3"), text("4"))
        val hidden = TurnLayout.build("t", items, finished = false, showThoughts = false)
        assertEquals(listOf("t:activity:2", "t:content:4"), hidden.blocks.map { it.key })
        val dsh = TurnLayout.build("t", items, finished = false, showThoughts = true)
        val groups = dsh.blocks.filterIsInstance<TurnLayout.Activity>()
        assertEquals(listOf("t:activity:1", "t:activity:2", "t:activity:3"), groups.map { it.key })
    }

    @Test fun thinkStepsAndPlanApprovalsAreNotGroupedSteps() {
        val layout = TurnLayout.build("t", listOf(tool("1", "think"), tool("2", "switch_mode"), text("3")), finished = true, showThoughts = false)
        assertEquals(listOf("t:content:2", "t:content:3"), layout.blocks.map { it.key })
        assertFalse("Nothing folds: the approval is never folded and the answer follows it", layout.folded)
    }

    @Test fun plansMoveBeforeTheirApprovalAndAttachmentsFollow() {
        val approval = TurnItem.Tool("4", "switch_mode", "Ready to code?", "pending",
            permission = app.lody.android.runtime.ToolPermission("r", pending = true, options = emptyList()))
        val file = TurnItem.File("2", "notes.md")
        val items = listOf(text("1"), file, tool("3", "read"), approval, text("5"), TurnItem.ProposedPlan("6", "plan"))
        val layout = TurnLayout.build("t", items, finished = false, showThoughts = false)
        assertEquals(
            listOf("t:content:1", "t:activity:3", "t:content:6", "t:content:4", "t:content:5", "t:content:2"),
            layout.blocks.map { it.key },
        )
        assertTrue("The turn shows its plan as its own row", layout.separatePlan)
        assertTrue("The approval still waits", layout.planAwaiting)
        // Without a proposed plan the turn keeps its order, and the approval's own plan is the card.
        val claude = TurnLayout.build("t", listOf(text("1"), file, approval.copy(plan = "plan")), finished = false, showThoughts = false)
        assertEquals(listOf("t:content:1", "t:content:2", "t:content:4"), claude.blocks.map { it.key })
        assertFalse(claude.separatePlan)
    }

    @Test fun tasksLeaveTheTurnBlocksForTheirOwnPanel() {
        val task = TurnItem.Task("9", "Explore", "map the repo", "running")
        val layout = TurnLayout.build("t", listOf(tool("1"), text("2"), task), finished = true, showThoughts = false)
        assertEquals(listOf(task), layout.tasks)
        assertEquals(listOf("t:content:2"), layout.visible.map { it.key })
        assertTrue("The answer still ends the turn, so the work folds", layout.folded)
    }
}
