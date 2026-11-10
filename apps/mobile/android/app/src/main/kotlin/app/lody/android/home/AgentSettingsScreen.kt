package app.lody.android.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.*
import kotlinx.coroutines.launch
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentSettingsScreen(home: ChatListUiState, service: AgentProviderService?, scope: RuntimeScope?, onBack: () -> Unit) {
    val state = remember(service, scope) { if (service != null && scope != null) AgentSettingsState(service, scope) else null }
    val tasks = rememberCoroutineScope()
    var machineId by rememberSaveable(scope) { mutableStateOf<String?>(null) }
    var picker by remember { mutableStateOf(false) }
    val data = state?.snapshot
    val machine = data?.machines?.find { it.id == machineId } ?: data?.machines?.firstOrNull()
    var editor by remember(scope, machine?.id) { mutableStateOf<ProviderEditor?>(null) }
    var deletion by remember(scope, machine?.id) { mutableStateOf<ProviderAction?>(null) }
    var deletionName by remember { mutableStateOf("") }
    val currentHome by rememberUpdatedState(home)
    LaunchedEffect(state) {
        snapshotFlow { currentHome.sync }.collect { state?.refresh() }
    }
    LaunchedEffect(state, service, scope) {
        if (state != null && service != null && scope != null) service.changes(scope).collect { state.refresh(it) }
    }
    val canManage = state?.canManage(machine) == true
    BackHandler { if (editor != null) editor = null else onBack() }
    val editing = editor
    if (editing != null && machine != null && state != null) {
        ProviderEditorScreen(editing, data?.catalog.orEmpty().filter { it.cliType != "builtin" || it.agentType == "deepseek" || machine.supportsSetup }, canManage,
            busy = state.busy, error = state.error, service = service!!, scope = scope!!, machineId = machine.id, supportsCodexProfiles = machine.supportsCodexProfiles, supportsPiExtensions = machine.supportsPiExtensions, presets = data?.presets.orEmpty(),
            onBack = { editor = null }, onSave = { fields ->
                tasks.launch {
                    if (state.perform(ProviderAction.Save(machine.id, editing.id, editing.base, fields))) editor = null
                }
            })
        return
    }
    Scaffold(containerColor = LodyTheme.colors.bgBase, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(LodyIcons.Back, stringResource(R.string.settings_agent_back)) }
            Text(stringResource(R.string.settings_agents), Modifier.weight(1f), style = LodyTheme.typography.headline, color = LodyTheme.colors.textPrimary)
            IconButton(onClick = { tasks.launch { state?.refresh() } }, enabled = state != null && !state.busy) {
                Icon(LodyIcons.Refresh, stringResource(R.string.settings_agent_refresh))
            }
        }
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
            if (state?.busy == true) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (state?.error != null) item { ProviderNotice(providerError(state.error)) }
            if (state?.authRequired == true) item { ProviderNotice(stringResource(R.string.settings_agent_auth_required)) }
            if (machine == null) {
                item { ProviderNotice(stringResource(if (state?.busy == true) R.string.settings_agent_loading else R.string.settings_agent_no_machines)) }
            } else {
                item {
                    Column(Modifier.padding(vertical = LodySpacing.md)) {
                        SettingsLine(machine.name.ifBlank { machine.id }, LodyIcons.Machine,
                            stringResource(if (machine.online) R.string.settings_agent_online else R.string.settings_agent_offline),
                            onClick = { picker = true }, leading = { PresenceDot(machine.online) })
                    }
                }
                if (!machine.online || machine.readOnly) item {
                    ProviderNotice(stringResource(if (machine.readOnly) R.string.settings_agent_read_only else R.string.settings_agent_offline_hint))
                }
                item {
                    Row(Modifier.fillMaxWidth().padding(start = LodySpacing.xxl, end = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.settings_agent_providers), Modifier.weight(1f), style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary)
                        TextButton(onClick = { editor = ProviderEditor() }, enabled = canManage) {
                            Icon(LodyIcons.Plus, null, Modifier.size(LodyIconSize.sm))
                            Spacer(Modifier.width(LodySpacing.xs))
                            Text(stringResource(R.string.settings_agent_add))
                        }
                    }
                }
                val providers = data?.providers.orEmpty().filter { it.machineId == machine.id }
                if (providers.isEmpty()) item { ProviderNotice(stringResource(R.string.settings_agent_empty)) }
                items(providers, key = { "provider-${it.id}" }) { provider ->
                    var menu by remember(provider.id) { mutableStateOf(false) }
                    SettingsLine(provider.name, LodyIcons.Agent,
                        provider.agentType, onClick = { editor = ProviderEditor(provider) },
                        leading = { AgentMark(provider.cliType, provider.agentType, LodyTheme.colors.textPrimary, Modifier.size(LodyIconSize.lg)) }, trailing = {
                            Box {
                                IconButton(onClick = { menu = true }, enabled = canManage && !provider.readOnly) {
                                    Icon(LodyIcons.More, stringResource(R.string.settings_agent_more))
                                }
                                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                    DropdownMenuItem(text = { Text(stringResource(R.string.settings_agent_edit)) }, onClick = { menu = false; editor = ProviderEditor(provider) })
                                    DropdownMenuItem(text = { Text(stringResource(R.string.settings_agent_refresh)) }, onClick = { menu = false; tasks.launch { state?.perform(ProviderAction.Refresh(provider)) } })
                                    DropdownMenuItem(text = { Text(stringResource(R.string.settings_agent_delete), color = LodyTheme.colors.dangerDefault) }, onClick = {
                                        menu = false; deletionName = provider.name; deletion = ProviderAction.Delete(provider)
                                    })
                                }
                            }
                        })
                    home.snapshot?.agentUsage?.get(machine.id)?.forProvider(provider).orEmpty().forEach { quota ->
                        Column(Modifier.padding(horizontal = LodySpacing.xxl, vertical = LodySpacing.sm)) { app.lody.android.chat.UsageQuotaView(quota) }
                    }
                }
                val setups = data?.setups.orEmpty().filter { it.machineId == machine.id }
                if (setups.isNotEmpty()) item { SettingsHeading(stringResource(R.string.settings_agent_setups)) }
                items(setups, key = { "setup-${it.id}" }) { setup ->
                    Column {
                        SettingsLine(setup.name, LodyIcons.Clock, setupStatus(setup.status), leading = {
                            AgentMark("builtin", setup.agentType, LodyTheme.colors.textSecondary, Modifier.size(LodyIconSize.lg))
                        })
                        if (setup.failureCode != null) ProviderNotice(stringResource(R.string.settings_agent_setup_failed))
                        Row(Modifier.fillMaxWidth().padding(horizontal = LodySpacing.lg), horizontalArrangement = Arrangement.End) {
                            if (setup.canRetry) TextButton(enabled = canManage && machine.supportsSetup, onClick = { tasks.launch { state?.perform(ProviderAction.RetrySetup(setup)) } }) {
                                Text(stringResource(R.string.settings_agent_retry))
                            }
                            if (setup.canDelete) TextButton(enabled = canManage, onClick = { deletionName = setup.name; deletion = ProviderAction.DeleteSetup(setup) }) {
                                Text(stringResource(R.string.settings_agent_remove), color = LodyTheme.colors.dangerDefault)
                            }
                        }
                    }
                }
            }
        }
    }
    if (picker) ModalBottomSheet(onDismissRequest = { picker = false }, containerColor = LodyTheme.colors.bgBase) {
        SettingsHeading(stringResource(R.string.settings_agent_machines))
        LazyColumn {
            items(data?.machines.orEmpty(), key = { it.id }) { item ->
                SettingsLine(item.name.ifBlank { item.id }, LodyIcons.Machine,
                    stringResource(if (item.online) R.string.settings_agent_online else R.string.settings_agent_offline),
                    onClick = { machineId = item.id; picker = false }, leading = { PresenceDot(item.online) }, trailing = {
                        if (item.id == machine?.id) Icon(LodyIcons.Check, stringResource(R.string.settings_agent_selected), tint = LodyTheme.colors.accentFg)
                    })
            }
        }
        Spacer(Modifier.height(LodySpacing.xxl))
    }
    val pending = deletion
    if (pending != null) AlertDialog(onDismissRequest = { deletion = null },
        title = { Text(stringResource(R.string.settings_agent_delete_title, deletionName)) },
        text = { Text(stringResource(R.string.settings_agent_delete_hint)) },
        confirmButton = { TextButton(enabled = canManage, onClick = { deletion = null; tasks.launch { state?.perform(pending) } }) { Text(stringResource(R.string.settings_agent_delete), color = LodyTheme.colors.dangerDefault) } },
        dismissButton = { TextButton(onClick = { deletion = null }) { Text(stringResource(R.string.settings_agent_cancel)) } })
}

internal data class ProviderEditor(val base: AgentProvider? = null, val id: String = base?.id ?: UUID.randomUUID().toString())

@Composable
private fun PresenceDot(online: Boolean) {
    Box(Modifier.size(LodySize.dot).background(if (online) LodyTheme.colors.accentFg else LodyTheme.colors.textSecondary, CircleShape))
}
@Composable
private fun ProviderNotice(text: String) {
    Text(text, Modifier.padding(horizontal = LodySpacing.xxl, vertical = LodySpacing.md), style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary)
}
@Composable
private fun setupStatus(status: String): String = stringResource(when (status) {
    "queued" -> R.string.settings_agent_setup_queued
    "preparing-runtime" -> R.string.settings_agent_setup_preparing
    "verifying" -> R.string.settings_agent_setup_verifying
    "awaiting-auth" -> R.string.settings_agent_auth_required
    "failed" -> R.string.settings_agent_setup_failed
    else -> R.string.settings_agent_setup_pending
})
@Composable
internal fun providerError(code: String?): String = stringResource(when (code) {
    "provider_load_failed" -> R.string.settings_agent_load_failed
    "setting_conflict", "provider_conflict" -> R.string.settings_agent_conflict
    "setting_read_only", "provider_read_only", "provider_not_owner" -> R.string.settings_agent_read_only
    else -> R.string.settings_agent_write_unknown
})

