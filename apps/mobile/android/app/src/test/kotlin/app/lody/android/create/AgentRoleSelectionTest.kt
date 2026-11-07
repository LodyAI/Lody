package app.lody.android.create

import app.lody.android.runtime.AgentRole
import app.lody.android.runtime.AgentRoleTarget
import app.lody.android.runtime.CreationAgent
import app.lody.android.runtime.RoleRunConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Web chat landing's Role row (`composer-agent-roles.ts`), as the Android create page applies it. */
class AgentRoleSelectionTest {
    private val pins = RoleRunConfig("opus", "plan", mapOf("reasoning_effort" to "high", "plan_mode" to true))
    private fun role(id: String, name: String, vararg targets: AgentRoleTarget) = AgentRole(id, name, "🧪", 4, targets.toList())
    private val online = listOf(CreationAgent("c1", "Coder", "m1", "builtin", "claude"))

    @Test fun rolesAreOfferedPerComputerAndKeepUnavailableOnesWithTheirReason() {
        val roles = listOf(
            role("r", "reviewer", AgentRoleTarget("m1", "c1", "configured", pins)),
            role("g", "Gone", AgentRoleTarget("m1", "x", "agentUnavailable")),
            role("o", "Offline", AgentRoleTarget("m1", "c9", "configured")),
            role("e", "Elsewhere", AgentRoleTarget("m2", "c2", "configured")),
        )
        val items = CreateSessionModel.roleItems(roles, "m1", online)
        assertEquals(listOf("g", "o", "r"), items.map { it.role.id })
        assertEquals(CreateSessionModel.RoleUnavailable.Agent, items[0].unavailable)
        assertEquals(CreateSessionModel.RoleUnavailable.Offline, items[1].unavailable)
        assertNull(items[2].unavailable)
        assertTrue(CreateSessionModel.roleItems(roles, null, online).isEmpty())
    }

    @Test fun pickingSeedsThePinsAndTheRoleHoldsOnlyWhileTheyRun() {
        val item = CreateSessionModel.roleItems(listOf(role("r", "Reviewer", AgentRoleTarget("m1", "c1", "configured", pins))), "m1", online).single()
        val choice = CreateSessionModel.roleChoice(item.target)
        assertEquals(CreateSessionModel.RoleChoice("opus", "plan", "high", mapOf("plan_mode" to true)), choice)
        assertTrue(CreateSessionModel.roleApplied(item, "c1", choice.modelId, choice.modeId, choice.effort))
        assertFalse("another agent", CreateSessionModel.roleApplied(item, "c2", "opus", "plan", "high"))
        assertFalse("a moved model", CreateSessionModel.roleApplied(item, "c1", "sonnet", "plan", "high"))
        assertFalse("a moved effort", CreateSessionModel.roleApplied(item, "c1", "opus", "plan", "low"))
        val unpinned = item.copy(target = item.target.copy(runConfig = RoleRunConfig()))
        assertTrue("unpinned values are the agent's own", CreateSessionModel.roleApplied(unpinned, "c1", "anything", null, null))
    }
}
