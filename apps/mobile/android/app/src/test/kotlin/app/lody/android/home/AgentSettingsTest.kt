package app.lody.android.home

import app.lody.android.runtime.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class AgentSettingsTest {
    private val scope = RuntimeScope("account", "workspace")
    private val machine = ProviderMachine("machine", "Computer", "darwin", false, true, true)
    private val provider = AgentProvider("provider", machine.id, "Codex", "Original prompt", "builtin", "codex", "", emptyList(), false)
    private fun snapshot(machine: ProviderMachine = this.machine, providers: List<AgentProvider> = listOf(provider)) = AgentProviders(listOf(machine), providers, emptyList(), listOf(ProviderCatalogEntry("codex", "Codex", "builtin", "codex")))

    @Test fun unknownMutationDisablesFurtherWritesUntilExplicitReadAndNeverReplays() = runTest {
        var stored = snapshot()
        val service = object : AgentProviderService {
            override suspend fun perform(scope: RuntimeScope, action: ProviderAction): AgentProviders = when (action) {
                ProviderAction.List -> stored
                is ProviderAction.Delete -> {
                    check(stored.providers.any { it.id == action.base.id }) { "unexpected replay" }
                    stored = snapshot(providers = emptyList())
                    throw app.lody.android.runtime.RuntimeException(RuntimeFault("provider_write_unknown", RuntimeErrorCategory.BUSINESS))
                }
                else -> error("unexpected action")
            }
        }
        val state = AgentSettingsState(service, scope)
        state.refresh()
        assertTrue(state.canManage(machine))
        assertFalse(state.perform(ProviderAction.Delete(provider)))
        assertEquals("provider_write_unknown", state.error)
        assertFalse(state.canManage(machine))
        assertFalse(state.perform(ProviderAction.Delete(provider)))
        assertEquals(listOf(provider), state.snapshot?.providers)
        state.refresh()
        assertEquals(emptyList<AgentProvider>(), state.snapshot?.providers)
        assertTrue(state.canManage(machine))
    }

    @Test fun foreignOrOfflineMachineDoesNotPermitMutation() = runTest {
        for (restricted in listOf(machine.copy(readOnly = true), machine.copy(online = false))) {
            val state = AgentSettingsState(object : AgentProviderService {
                override suspend fun perform(scope: RuntimeScope, action: ProviderAction): AgentProviders {
                    check(action == ProviderAction.List) { "unauthorized mutation" }
                    return snapshot(restricted)
                }
            }, scope)
            state.refresh()
            assertFalse(state.canManage(restricted))
            assertFalse(state.perform(ProviderAction.Delete(provider)))
            assertEquals(listOf(provider), state.snapshot?.providers)
        }
    }

    @Test fun pendingMutationRejectsDuplicateAndQueuesTargetInvalidation() = runTest {
        val submitted = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        var stored = snapshot()
        val state = AgentSettingsState(object : AgentProviderService {
            override suspend fun perform(scope: RuntimeScope, action: ProviderAction): AgentProviders {
                if (action == ProviderAction.List || action is ProviderAction.ListMachine) return stored
                check(action is ProviderAction.Delete)
                submitted.complete(Unit)
                finish.await()
                stored = snapshot(providers = emptyList())
                return stored
            }
        }, scope)
        state.refresh()
        val writing = async { state.perform(ProviderAction.Delete(provider)) }
        submitted.await()
        assertTrue(state.busy)
        val refreshing = async { state.refresh(machine.id) }
        assertFalse(state.perform(ProviderAction.Delete(provider)))
        assertEquals(listOf(provider), state.snapshot?.providers)
        finish.complete(Unit)
        assertTrue(writing.await())
        refreshing.await()
        assertFalse(state.busy)
        assertEquals(emptyList<AgentProvider>(), state.snapshot?.providers)
    }

    @Test fun providerSnapshotAndCommandsPreserveOpaqueArgumentsAndConflictBase() {
        val custom = provider.copy(cliType = "custom", agentType = "custom-provider", command = "agent", args = listOf("--path", "/a folder", ""))
        val fields = ProviderFields("New name", custom.prompt, custom.cliType, custom.agentType, custom.command, custom.args)
        val command = AgentProviderJson.request(ProviderAction.Save(machine.id, custom.id, custom, fields))
        assertEquals("Original prompt", command.getJSONObject("base").getString("prompt"))
        assertEquals("Codex", command.getJSONObject("base").getString("name"))
        assertEquals("/a folder", command.getJSONObject("fields").getJSONArray("args").getString(1))
        assertEquals("", command.getJSONObject("fields").getJSONArray("args").getString(2))
        assertFalse(command.has("workspaceId"))
        assertFalse(command.has("userId"))
        assertTrue(fields.valid)
        assertFalse(fields.copy(command = "").valid)
        assertFalse(fields.copy(args = List(129) { "argument" }).valid)
        val removal = AgentProviderJson.request(ProviderAction.Delete(custom))
        assertEquals(setOf("action", "base"), removal.keys().asSequence().toSet())
    }
    @Test fun quotaDisplayRequiresExactEligibleConfigAndPreservesZeroWindows() {
        val json = org.json.JSONObject("""{"agentUsage":{"machine":{"configs":[{"id":"provider","provider":"codex","eligible":true}],"quotas":[{"provider":"codex","agentConfigId":"provider","windows":[{"usedPercent":0,"duration":18000}]},{"provider":"codex","agentConfigId":"other","windows":[{"usedPercent":90}]}]}}}""")
        val usage = ProviderUsageJson.parse(json).getValue("machine")
        assertEquals(1, usage.forProvider(provider).size)
        assertEquals(0.0, usage.forProvider(provider).single().windows.single().usedPercent, 0.0)
        assertTrue(usage.forProvider(provider.copy(id = "other")).isEmpty())
        assertTrue(usage.forProvider(provider.copy(agentType = "claude")).isEmpty())
        assertTrue(usage.copy(configs = usage.configs.map { it.copy(eligible = false) }).forProvider(provider).isEmpty())
        assertTrue(ProviderUsageJson.parse(org.json.JSONObject()).isEmpty())
    }

    @Test fun targetMutationPreservesOtherMachineProvidersWithoutReadingThem() = runTest {
        val other = machine.copy(id = "other")
        val otherProvider = provider.copy(id = "other-provider", machineId = other.id)
        var wrote = false
        val state = AgentSettingsState(object : AgentProviderService {
            override suspend fun perform(scope: RuntimeScope, action: ProviderAction): AgentProviders {
                if (action == ProviderAction.List) {
                    check(!wrote) { "unrelated machine read after write" }
                    return snapshot().copy(machines = listOf(machine, other), providers = listOf(provider, otherProvider))
                }
                wrote = true
                return snapshot(providers = emptyList()).copy(machines = listOf(machine, other))
            }
        }, scope)
        state.refresh()
        assertTrue(state.perform(ProviderAction.Delete(provider)))
        assertEquals(emptyList<AgentProvider>(), state.snapshot!!.providers.filter { it.machineId == machine.id })
        assertEquals(listOf(otherProvider), state.snapshot!!.providers.filter { it.machineId == other.id })
        assertTrue(state.canManage(other))
    }

    @Test fun advancedSavePreservesKeepReplaceAndRemoveSemanticsWithConflictRevision() {
        val fields = ProviderFields("Provider", "", "builtin", "codex", "", emptyList(), ProviderAdvanced(
            detailRevision = "opaque-revision", envPatch = mapOf("REPLACE" to "synthetic", "EMPTY" to "", "REMOVE" to null),
            runtimePaths = mapOf("codexPath" to null), titleValues = mapOf("model" to "selected-model", "thinking" to true)))
        val encoded = AgentProviderJson.request(ProviderAction.Save(machine.id, provider.id, provider, fields)).getJSONObject("fields")
        val env = encoded.getJSONObject("envPatch")
        assertFalse(env.has("KEEP"))
        assertEquals("synthetic", env.getString("REPLACE"))
        assertEquals("", env.getString("EMPTY"))
        assertTrue(env.has("REMOVE") && env.isNull("REMOVE"))
        assertEquals("opaque-revision", encoded.getString("detailRevision"))
        assertEquals("codexPath", encoded.getJSONObject("runtimeOverrides").getJSONArray("remove").getString(0))
        assertEquals(true, encoded.getJSONObject("titleGeneration").getJSONObject("value").getJSONObject("configOptionValues").getBoolean("thinking"))
        assertFalse(AgentProviderJson.request(ProviderAction.Save(machine.id, provider.id, provider, fields.copy(advanced = null))).getJSONObject("fields").has("envPatch"))
    }

    @Test fun providerDetailContainsOnlyCredentialKeysAndAdvertisedChoices() {
        val decoded = ProviderDetailsJson.detail(org.json.JSONObject("""{"id":"provider","machineId":"machine","revision":"revision","description":"","env":[{"key":"EXAMPLE_TOKEN","hasValue":true}],"endpoints":[],"runtimeOverrides":{},"titleGeneration":null,"capabilities":{"models":[{"id":"m","name":"Model"}],"modes":[],"sessionTitle":false,"options":[],"authMethods":[{"id":"login","name":"Sign in"}]},"supportsAuthentication":true,"supportsMethodSelection":true,"supportsCodexProfiles":false}"""))
        assertEquals(listOf("EXAMPLE_TOKEN"), decoded.envKeys)
        assertEquals("m", decoded.capabilities.models.single().id)
        assertTrue(decoded.supportsAuthentication)
        val request = ProviderDetailsJson.authRequest(ProviderAuthRequest("machine", "provider", "submit", "flow", interactionId = "input", values = mapOf("api-key" to "synthetic")))
        assertEquals("input", request.getString("interactionId"))
        assertEquals("synthetic", request.getJSONObject("values").getString("api-key"))
        assertFalse(request.has("userId"))
        assertFalse(request.has("workspaceId"))
    }

    @Test fun targetInvalidationReplacesPendingSetupWithoutDroppingOtherMachines() = runTest {
        val other = machine.copy(id = "other")
        val otherProvider = provider.copy(id = "other-provider", machineId = other.id)
        val pending = ProviderSetup("setup", machine.id, "Pending", "codex", "queued", 1, false, true, null)
        val state = AgentSettingsState(object : AgentProviderService {
            override suspend fun perform(scope: RuntimeScope, action: ProviderAction) = when (action) {
                ProviderAction.List -> snapshot().copy(machines = listOf(machine, other), providers = listOf(provider, otherProvider), setups = listOf(pending))
                ProviderAction.ListMachine(machine.id) -> snapshot().copy(machines = listOf(machine, other), setups = listOf(pending.copy(status = "awaiting-auth")))
                else -> error("unexpected write or unrelated machine read")
            }
        }, scope)
        state.refresh()
        state.refresh(machine.id)
        assertEquals("awaiting-auth", state.snapshot!!.setups.single().status)
        assertEquals(listOf(provider, otherProvider).toSet(), state.snapshot!!.providers.toSet())
    }

}
