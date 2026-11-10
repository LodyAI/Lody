package app.lody.android.diagnostics

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.*
import app.lody.android.designsystem.LodyTheme
import app.lody.android.home.*
import app.lody.android.runtime.*

/** Synthetic native settings acceptance, without credentials, runtime or network calls. */
class AgentSettingsProbeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val machines = listOf(
            ProviderMachine("online", "Studio computer", "darwin", false, true, true),
            ProviderMachine("other", "Second computer", "linux", false, true, true),
            ProviderMachine("empty", "Empty computer", "linux", false, true, true),
            ProviderMachine("readonly", "Shared computer", "linux", true, true, false),
            ProviderMachine("offline", "Offline computer", "linux", false, false, false),
        )
        var stored = AgentProviders(machines, listOf(
            AgentProvider("shared-provider", "readonly", "Shared assistant", "", "builtin", "codex", "", emptyList(), true),
            AgentProvider("pi-provider", "online", "Pi", "", "builtin", "pi", "", emptyList(), false),
            AgentProvider("other-provider", "other", "Other machine assistant", "", "builtin", "codex", "", emptyList(), false),
            AgentProvider("codex", "online", "Codex", "", "builtin", "codex", "", emptyList(), false),
            AgentProvider("custom", "online", "Custom assistant", "Keep this prompt", "custom", "custom-custom", "agent", listOf("--path", "/a folder"), false),
        ), listOf(ProviderSetup("setup", "online", "Claude", "claude", "failed", 1, true, true, "setup_failed")), listOf(
            ProviderCatalogEntry("codex", "Codex", "builtin", "codex"),
            ProviderCatalogEntry("custom", "Custom", "custom", "custom"),
        ))
        var authentication: ProviderAuthState? = null
        val service = object : AgentProviderService {
            override suspend fun operation(scope: RuntimeScope, machineId: String, id: String?, action: String, cliType: String?, agentType: String?) = ProviderOperation(action, true,
                if (action.startsWith("binary")) "installed" else null, if (action == "pi-extension-scan") listOf(ProviderChoice("/synthetic/extension", "Fixture extension")) else emptyList(), "1.0-fixture", null, null, null)
            override suspend fun detail(scope: RuntimeScope, machineId: String, id: String) = ProviderDetail(id, machineId, "fixture-revision", "Synthetic provider", listOf("EXAMPLE_TOKEN"), emptyMap(), emptyMap(), emptyList(), emptyMap(), null, null,
                ProviderCapabilities(models = listOf(ProviderChoice("fixture-model", "Fixture model"))), true, false, false, supportsPiExtensions = id == "pi-provider", supportsRateLimitsRefresh = true)
            override suspend fun probe(scope: RuntimeScope, machineId: String, id: String) = ProviderProbe(true, false, ProviderCapabilities(models = listOf(ProviderChoice("fixture-model", "Fixture model"))))
            override suspend fun auth(scope: RuntimeScope, request: ProviderAuthRequest): ProviderAuthState {
                val previous = authentication
                authentication = when (request.action) {
                    "start" -> if (request.methodId == null) ProviderAuthState(request.flowId, "method-required", listOf(ProviderChoice("fixture", "Fixture sign in")), emptyList(), null, null, null, false, null)
                        else {
                            check(request.flowId != previous?.flowId) { "Final method selection requires a fresh flow" }
                            ProviderAuthState(request.flowId, "input-required", emptyList(), listOf(ProviderAuthField("fixture-key", "Example key", "secret", true, emptyList())), "fixture-interaction", null, null, false, null)
                        }
                    "submit" -> {
                        check(request.interactionId == "fixture-interaction" && request.values?.get("fixture-key") == "synthetic-key")
                        previous!!.copy(status = "authenticated", fields = emptyList())
                    }
                    "cancel" -> previous!!.copy(status = "cancelled")
                    else -> previous!!
                }
                return authentication!!
            }

            override suspend fun perform(scope: RuntimeScope, action: ProviderAction): AgentProviders {
                stored = when (action) {
                    ProviderAction.List, is ProviderAction.ListMachine -> stored
                    is ProviderAction.Save -> stored.copy(providers = stored.providers.filterNot { it.id == action.id } + action.fields.let {
                        AgentProvider(action.id, action.machineId, it.name, it.prompt, it.cliType, it.agentType, it.command, it.args, false)
                    })
                    is ProviderAction.Delete -> stored.copy(providers = stored.providers.filterNot { it.id == action.base.id })
                    is ProviderAction.Refresh -> stored.copy(authRequired = true)
                    is ProviderAction.RetrySetup -> stored.copy(setups = stored.setups.map { if (it.id == action.setup.id) it.copy(status = "queued", canRetry = false, failureCode = null) else it })
                    is ProviderAction.DeleteSetup -> stored.copy(setups = stored.setups.filterNot { it.id == action.setup.id })
                }
                return stored
            }
        }
        setContent {
            LodyTheme {
                var agents by remember { mutableStateOf(intent.getBooleanExtra("agents", true)) }
                val home = ChatListUiState(accountName = "Alex Example", accountEmail = "alex@example.invalid", workspaceName = "Example workspace",
                    initial = "E", sync = HomeSyncState.Live, timeline = emptyList(), snapshot = null, userId = "fixture",
                    projects = emptyList(), placeholder = "", workspaces = emptyList(), workspaceId = "workspace")
                if (agents) AgentSettingsScreen(home, service, RuntimeScope("fixture", "workspace")) { agents = false }
                else SettingsHome(home, PaddingValues(), {}, {}, { agents = true }, {})
            }
        }
    }
}
