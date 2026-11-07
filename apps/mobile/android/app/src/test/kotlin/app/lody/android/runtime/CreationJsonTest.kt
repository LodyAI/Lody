package app.lody.android.runtime

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CreationJsonTest {
    @Test fun modelControlsFollowTheSelectedModelAfterCacheRestore() {
        val json = JSONObject("""{"capabilities":[{"machineId":"m","agentConfigId":"a","cliType":"builtin","agentType":"codex","reasoningEfforts":{"small":[],"large":["high","max"]},"fastModes":{"small":false,"large":true},"configOptions":[{"id":"model","category":"model","currentValue":"small"},{"id":"fast-mode","type":"boolean","currentValue":false}]}]}""")
        val options = CreationJson.options(CreationJson.encodeOptions(CreationJson.options(json)))
        val capability = options.capabilities.single()
        assertEquals(listOf("high", "max"), capability.effortsFor("large"))
        assertEquals(emptyList<String>(), capability.effortsFor("small"))
        assertNull(capability.fastOn(emptyMap()))
        assertNull(capability.fastValue(true, "small"))
        assertEquals(false, capability.fastOn(emptyMap(), "large"))
    }

    @Test fun machinePresenceIsReadButNeverRestoredFromCache() {
        val options = CreationJson.options(JSONObject("""{"availability":"online","agents":[],"capabilities":[],"onlineMachineIds":["without-agent"]}"""))
        assertEquals(setOf("without-agent"), options.onlineMachineIds)
        assertNull(CreationJson.options(CreationJson.encodeOptions(options)).onlineMachineIds)
        assertEquals(emptySet<String>(), CreationJson.options(JSONObject("""{"onlineMachineIds":[]}""")).onlineMachineIds)
        assertNull(CreationJson.options(JSONObject()).onlineMachineIds)
    }

    @Test fun completeOptionsSurvivePersistenceRoundTrip() {
        val a = CreationAgent("provider", "Provider", "machine", "acp", "codex")
        val c = CreationCapability("machine", "acp", "codex", listOf(CreationChoice("m", "Model")), listOf(CreationChoice("auto", "Auto")), mapOf("m" to listOf("low", "high")), "provider")
        val options = CreationOptions(listOf(a), listOf(c, c.copy(agentConfigId = "other")))
        assertEquals(options, CreationJson.options(JSONObject(CreationJson.encodeOptions(options).toString())))
    }

    @Test fun planAndFastSwitchesAreReadAndSurvivePersistence() {
        val options = CreationJson.options(JSONObject("""{"agents":[],"capabilities":[{"machineId":"m","cliType":"builtin","agentType":"codex","models":[],"modes":[],"reasoningEfforts":{},
            "configOptions":[{"id":"reasoning_effort","type":"select","category":"thought_level","options":[{"id":"low","name":"Low"}]},
            {"id":"collaboration_mode","type":"select","currentValue":"default","options":[{"id":"default","name":"Default"},{"id":"plan","name":"Plan"}]},
            {"id":"fast","type":"boolean","currentValue":false}]}]}"""))
        val capability = options.capabilities.single()
        assertEquals(listOf("collaboration_mode", "fast"), capability.switches.map { it.id })
        assertEquals(false, capability.planOn(emptyMap()))
        assertEquals("collaboration_mode" to "plan", capability.planValue(true))
        assertEquals("fast" to true, capability.fastValue(true))
        assertEquals(options, CreationJson.options(JSONObject(CreationJson.encodeOptions(options).toString())))
    }

    @Test fun providerCapabilityNeverFallsBackToAnotherProviderOfTheSameType() {
        val agent = CreationAgent("a", "A", "m", "builtin", "codex")
        val other = CreationCapability("m", "builtin", "codex", emptyList(), emptyList(), emptyMap(), "b")
        assertNull(CreationOptions(listOf(agent), listOf(other)).capability(agent))
        val own = other.copy(agentConfigId = "a")
        assertEquals(own, CreationOptions(listOf(agent), listOf(other, own)).capability(agent))
    }
    @Test fun readsAdvertisedAgentModelAndReasoningChoices() {
        val options = CreationJson.options(JSONObject("""{"agents":[{"id":"a","name":"Assistant","machineId":"m","cliType":"builtin","agentType":"codex"}],"capabilities":[{"machineId":"m","cliType":"builtin","agentType":"codex","models":[{"id":"model","name":"Model"}],"modes":[{"id":"auto","name":"Auto"}],"reasoningEfforts":{"model":["low","high"]}}]}"""))
        assertEquals("a", options.agents.single().id)
        assertEquals(listOf("low", "high"), options.capabilities.single().efforts["model"])
        assertEquals("auto", options.capabilities.single().modes.single().id)
    }
    @Test fun thoughtLevelFallbackSurvivesCacheAndHonorsPerModelOverrides() {
        val options = CreationJson.options(JSONObject("""{"capabilities":[{"machineId":"m","cliType":"builtin","agentType":"grok","reasoningEfforts":{"model":["high"],"off":[]},"configOptions":[{"id":"model","category":"model","currentValue":"model"},{"id":"thinking","type":"select","category":"thought_level","options":[{"id":"low","name":"Low"},{"id":"high","name":"High"}]}]}]}"""))
        val capability = options.capabilities.single()
        assertEquals(listOf("high"), capability.effortsFor(null))
        assertEquals(listOf("low", "high"), capability.effortsFor("other"))
        assertEquals(emptyList<String>(), capability.effortsFor("off"))
        assertEquals(options, CreationJson.options(CreationJson.encodeOptions(options)))
    }
    @Test fun creationPayloadKeepsStableIdsAndExplicitSelectionsWithoutIdentity() {
        val request = CreateRequest("session", "turn", null, "m", "a", "中文", null, true, "model", "auto", "high")
        val json = CreationJson.request(request)
        assertEquals("session", json.getString("sessionId")); assertEquals("turn", json.getString("turnId"))
        assertEquals("中文", json.getString("text")); assertTrue(json.getBoolean("worktree"))
        assertFalse(json.has("userId")); assertFalse(json.has("workspaceId")); assertFalse(json.has("projectId"))
    }

    @Test fun agentRolesKeepPinsAsStringsOrBooleansAndDefaultTheEmoji() {
        val json = JSONObject("""{"roles":[{"id":"r","name":"Reviewer","revision":3,"targets":[{"machineId":"m","agentConfigId":"a","state":"configured",
          "runConfig":{"modelId":"opus","configOptionValues":{"reasoning_effort":"high","plan_mode":true,"nested":{"x":1}}}}]}]}""")
        val role = CreationJson.roles(json).single()
        assertEquals("🪼", role.emoji)
        assertEquals(3, role.revision)
        assertEquals(RoleRunConfig("opus", null, mapOf("reasoning_effort" to "high", "plan_mode" to true)), role.targets.single().runConfig)
    }

    @Test fun aRoleCreationCarriesItsIdAndPinnedOptions() {
        val request = CreateRequest("s", "t", null, "m", "a", "hi", null, false, "opus", null, "high", agentRoleId = "r", configOptionValues = mapOf("plan_mode" to true))
        val json = CreationJson.request(request)
        assertEquals("r", json.getString("agentRoleId"))
        assertEquals(true, json.getJSONObject("configOptionValues").getBoolean("plan_mode"))
        assertFalse(CreationJson.request(request.copy(agentRoleId = null, configOptionValues = emptyMap())).has("agentRoleId"))
    }
}
