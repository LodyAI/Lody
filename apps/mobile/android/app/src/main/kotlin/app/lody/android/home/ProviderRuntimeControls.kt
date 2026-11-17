package app.lody.android.home

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun ProviderRuntimeControls(service: AgentProviderService, scope: RuntimeScope, machineId: String, id: String?, detail: ProviderDetail?, cliType: String, agentType: String, supportsPiExtensions: Boolean, enabled: Boolean, extensions: List<String>, onExtensions: (List<String>) -> Unit) {
    val tasks = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<ProviderOperation?>(null) }
    var discovered by remember { mutableStateOf<List<ProviderChoice>>(emptyList()) }
    var failed by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf<RuntimeEvent.ProviderProgress?>(null) }
    LaunchedEffect(service, scope, machineId, id) { service.progress(scope).collect { if (it.machineId == machineId && it.id == id) progress = it } }
    fun run(action: String) {
        if (busy != null) return
        tasks.launch {
            busy = action; failed = false; progress = null
            try {
                val next = service.operation(scope, machineId, id, action, cliType, agentType)
                result = next; failed = !next.success
                if (action == "pi-extension-scan" && next.success) discovered = next.extensions
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { failed = true }
            finally { busy = null }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
        if (busy != null) {
            val percent = progress?.percent
            if (percent != null) LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth()) else LinearProgressIndicator(Modifier.fillMaxWidth())
            Text(stringResource(R.string.settings_agent_operation_running), style = LodyTheme.typography.footnote)
        }
        if (failed) Text(stringResource(R.string.settings_agent_operation_failed), style = LodyTheme.typography.footnote)
        result?.status?.let { status ->
            Text(stringResource(when (status) {
                "installed" -> R.string.settings_agent_runtime_installed
                "not-installed" -> R.string.settings_agent_runtime_missing
                "incompatible-host" -> R.string.settings_agent_runtime_incompatible
                "unsupported-platform" -> R.string.settings_agent_runtime_platform
                "not-applicable" -> R.string.settings_agent_runtime_external
                else -> R.string.settings_agent_operation_failed
            }))
            result?.version?.let { Text(it, style = LodyTheme.typography.footnote) }
            result?.required?.let { Text(stringResource(R.string.settings_agent_runtime_required, it), style = LodyTheme.typography.footnote) }
        }
        Row {
            TextButton(enabled = enabled && busy == null && "binary-status" !in detail?.unavailableActions.orEmpty(), onClick = { run("binary-status") }) { Text(stringResource(R.string.settings_agent_binary_status)) }
            TextButton(enabled = enabled && busy == null && "binary-install" !in detail?.unavailableActions.orEmpty(), onClick = { run("binary-install") }) { Text(stringResource(R.string.settings_agent_binary_install)) }
        }
        TextButton(enabled = enabled && busy == null && (detail?.supportsRateLimitsRefresh == true && "rate-limits-refresh" !in detail.unavailableActions), onClick = { run("rate-limits-refresh") }) { Text(stringResource(R.string.settings_agent_refresh_usage)) }
        if ((detail?.supportsPiExtensions ?: (supportsPiExtensions && agentType == "pi"))) {
            TextButton(enabled = enabled && busy == null && "pi-extension-scan" !in detail?.unavailableActions.orEmpty(), onClick = { run("pi-extension-scan") }) { Text(stringResource(R.string.settings_agent_scan_extensions)) }
            (discovered + extensions.filter { path -> discovered.none { it.id == path } }.map { ProviderChoice(it, it) }).forEach { extension ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = extension.id in extensions, enabled = enabled && busy == null, onCheckedChange = { selected -> onExtensions(if (selected) extensions + extension.id else extensions - extension.id) })
                    Text(extension.name, style = LodyTheme.typography.body)
                }
            }
        }
        if ("sorbetCredentials" in detail?.unavailableActions.orEmpty() || "sorbetProviders" in detail?.unavailableActions.orEmpty()) Text(stringResource(R.string.settings_agent_sorbet_unavailable), style = LodyTheme.typography.footnote)
    }
}
