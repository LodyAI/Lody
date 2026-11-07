package app.lody.android.chat

import app.lody.android.create.CreateSessionModel
import app.lody.android.runtime.AgentRole
import app.lody.android.runtime.AgentRoleTarget
import app.lody.android.runtime.CreationAgent
import app.lody.android.runtime.CreationCapability
import app.lody.android.runtime.CreationChoice
import app.lody.android.runtime.RoleRunConfig
import app.lody.android.runtime.RoleSend
import app.lody.android.runtime.RunChoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Web's session composer Roles (`selectSessionAgentRoles`, `use-session-agent-role.ts`): only Roles
 * bound to the conversation's own computer and Agent Config, pins applied without changing the
 * agent, and the Role sent only while it is what will run. iOS: `SessionRoles`.
 */
class SessionRolesTest {
    private val pins = RoleRunConfig("gpt", null, mapOf("reasoning_effort" to "high", "fast" to true))
    private fun role(id: String, name: String, machine: String = "m1", config: String = "a1", state: String = "configured", run: RoleRunConfig = RoleRunConfig()) =
        AgentRole(id, name, "🧪", 2, listOf(AgentRoleTarget(machine, config, state, run)))
    private val roles = listOf(
        role("w", "Writer"), role("x", "Other agent", config = "a2"), role("r", "Reviewer", run = pins),
        role("y", "Other machine", machine = "m2"), role("b", "Broken", state = "agentUnavailable"),
    )
    private val online = listOf(CreationAgent("a1", "Codex", "m1", "builtin", "codex"), CreationAgent("a2", "Other", "m1", "builtin", "codex"))
    private val capability = CreationCapability(
        "m1", "builtin", "codex", listOf(CreationChoice("gpt", "GPT"), CreationChoice("mini", "Mini")),
        listOf(CreationChoice("default", "Default")), mapOf("gpt" to listOf("low", "high")), agentConfigId = "a1",
    )
    private val items get() = SessionRoles.items(roles, "m1", "a1", online)
    private val applied = SessionRoles.Choice("gpt", "high", null, mapOf("fast" to true))

    @Test fun onlyRolesBoundToTheConversationsComputerAndAgentConfigAreOffered() {
        assertEquals(listOf("b", "r", "w"), items.map { it.role.id })
        assertEquals(CreateSessionModel.RoleUnavailable.Agent, items[0].unavailable)
        assertNull(items[1].unavailable)
        assertTrue(SessionRoles.items(roles, "m1", "a1", emptyList()).all { it.unavailable != null })
        assertTrue(SessionRoles.items(roles, "m1", null, online).isEmpty())
    }

    @Test fun pickingARoleAppliesOnlyItsPinsTheAgentOffers() {
        val current = SessionRoles.Choice("mini", "low", "default", mapOf("sandbox" to "on"))
        val picked = SessionRoles.apply(items.first { it.role.id == "r" }, current, capability)
        assertEquals("gpt", picked.modelId)
        assertEquals("high", picked.effort)
        assertEquals("default", picked.modeId)
        assertEquals(mapOf("sandbox" to "on", "fast" to true), picked.options)
        val unsupported = SessionRoles.apply(
            SessionRoles.items(listOf(role("u", "U", run = RoleRunConfig("gone", "nope"))), "m1", "a1", online)[0], current, capability,
        )
        assertEquals("mini", unsupported.modelId)
        assertEquals("default", unsupported.modeId)
    }

    @Test fun theShownRoleIsThePickElseTheLatestTurnsWhileItStillApplies() {
        val durable = SessionRoles.Pick.Role("r")
        assertEquals("r", SessionRoles.active(items, null, durable, "a1", applied)?.role?.id)
        assertNull(SessionRoles.active(items, SessionRoles.Pick.None, durable, "a1", applied))
        assertEquals("w", SessionRoles.active(items, SessionRoles.Pick.Role("w"), durable, "a1", applied)?.role?.id)
        assertNull(SessionRoles.active(items, null, durable, "a1", applied.copy(modelId = "mini")))
        assertNull(SessionRoles.active(items, SessionRoles.Pick.Role("b"), null, "a1", SessionRoles.Choice(null, null, null, emptyMap())))
    }

    @Test fun aTurnCarriesTheRoleANoneOnceItDetachesOrNothingWhileUnknown() {
        val durable = SessionRoles.Pick.Role("r")
        val active = SessionRoles.active(items, null, durable, "a1", applied)
        assertEquals(RoleSend.Role("r"), SessionRoles.send(true, active, null, durable))
        assertEquals(RoleSend.None, SessionRoles.send(true, null, null, durable))
        assertEquals(RoleSend.None, SessionRoles.send(true, null, SessionRoles.Pick.None, null))
        assertEquals(RoleSend.Inherit, SessionRoles.send(false, null, null, durable))
        assertEquals(RoleSend.Inherit, SessionRoles.send(true, null, null, null))
    }

    @Test fun theLatestTurnsRoleComesFromTheComposerProjection() {
        assertNull(SessionRoles.durable(RunChoice()))
        assertNull(SessionRoles.durable(null))
        assertEquals(SessionRoles.Pick.None, SessionRoles.durable(RunChoice(roleKnown = true)))
        assertEquals(SessionRoles.Pick.Role("r"), SessionRoles.durable(RunChoice(agentRoleId = "r", roleKnown = true)))
    }

    @Test fun planAndFastSwitchesFollowTheAgentsOptions() {
        val plan = app.lody.android.runtime.CreationConfigOption("collaboration_mode", null, "select", "default", listOf("default", "plan"))
        val fast = app.lody.android.runtime.CreationConfigOption("fast", null, "boolean", false)
        val withSwitches = capability.copy(switches = listOf(plan, fast))
        assertEquals(plan, withSwitches.planSwitch)
        assertEquals(fast, withSwitches.fastSwitch)
        assertEquals(false, withSwitches.switchOn(plan, emptyMap()))
        assertEquals(true, withSwitches.switchOn(plan, mapOf("collaboration_mode" to withSwitches.switchValue(plan, true))))
        assertEquals("default", withSwitches.switchValue(plan, false))
        assertEquals(true, withSwitches.switchValue(fast, true))
        assertNull(capability.planSwitch)
    }
}
