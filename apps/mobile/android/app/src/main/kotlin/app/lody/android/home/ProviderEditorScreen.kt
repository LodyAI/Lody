package app.lody.android.home

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun ProviderChoiceField(label: String, value: String, choices: List<ProviderChoice>, enabled: Boolean, onChange: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        Text(label, style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary)
        Box {
            OutlinedButton(enabled = enabled, onClick = { open = true }) { Text(choices.find { it.id == value }?.name ?: value.ifEmpty { "—" }) }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                choices.forEach { item -> DropdownMenuItem(text = { Text(item.name) }, onClick = { open = false; onChange(item.id) }) }
            }
        }
    }
}

@Composable
internal fun ProviderEditorScreen(editor: ProviderEditor, catalog: List<ProviderCatalogEntry>, canManage: Boolean, busy: Boolean, error: String?, service: AgentProviderService, scope: RuntimeScope, machineId: String, supportsCodexProfiles: Boolean, supportsPiExtensions: Boolean, presets: List<ProviderPreset>, onBack: () -> Unit, onSave: (ProviderFields) -> Unit) {
    val base = editor.base
    val tasks = rememberCoroutineScope()
    var name by rememberSaveable(editor.id) { mutableStateOf(base?.name.orEmpty()) }
    var prompt by rememberSaveable(editor.id) { mutableStateOf(base?.prompt.orEmpty()) }
    var selection by remember(editor.id) { mutableStateOf(catalog.firstOrNull()?.id.orEmpty()) }
    var cliType by rememberSaveable(editor.id) { mutableStateOf(base?.cliType ?: catalog.firstOrNull()?.cliType.orEmpty()) }
    var agentType by rememberSaveable(editor.id) { mutableStateOf(base?.agentType ?: catalog.firstOrNull()?.agentType.orEmpty()) }
    var command by rememberSaveable(editor.id) { mutableStateOf(base?.command.orEmpty()) }
    var arguments by rememberSaveable(editor.id) { mutableStateOf(base?.args?.joinToString("\n").orEmpty()) }
    var detail by remember(editor.id) { mutableStateOf<ProviderDetail?>(null) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var refreshProgress by remember { mutableStateOf<RuntimeEvent.ProviderRefreshProgress?>(null) }
    var refreshResult by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(service, scope, editor.id) {
        service.refreshProgress(scope).collect { if (refreshing && it.id == editor.id && it.machineId == machineId) refreshProgress = it }
    }
    var capabilities by remember { mutableStateOf(ProviderCapabilities()) }
    var description by remember { mutableStateOf("") }
    var envPatch by remember(editor.id) { mutableStateOf<Map<String, String?>>(emptyMap()) }
    var paths by remember { mutableStateOf<Map<String, String?>>(emptyMap()) }
    var titles by remember { mutableStateOf<Map<String, Any>>(emptyMap()) }
    var extensions by remember { mutableStateOf<List<String>>(emptyList()) }
    var codexAuth by remember { mutableStateOf<ProviderCodexAuth?>(null) }
    var presetId by remember { mutableStateOf<String?>(null) }
    var presetMode by remember { mutableStateOf<String?>(null) }
    var endpoint by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        loading = true; failed = false
        try {
            val next = service.detail(scope, machineId, editor.id)
            detail = next; capabilities = next.capabilities; description = next.description
            paths = next.runtimePaths; titles = next.titleValues; presetId = next.presetId; extensions = next.piExtensions; codexAuth = next.codexAuth
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { failed = true }
        finally { loading = false }
    }
    LaunchedEffect(editor.id) { if (base != null) load() }
    val preset = presets.find { it.id == presetId }
    val mode = preset?.modes?.find { it.id == presetMode } ?: preset?.modes?.firstOrNull()
    val editable = canManage && base?.readOnly != true && !loading
    val fields = ProviderFields(name, prompt, cliType, agentType, if (cliType == "custom") command else "", if (cliType != "custom") emptyList() else if (base != null && arguments == base.args.joinToString("\n")) base.args else if (arguments.isEmpty()) emptyList() else arguments.split('\n'),
        ProviderAdvanced(detailRevision = detail?.revision, description = description.takeIf { detail != null || it.isNotEmpty() }, envPatch = envPatch.takeIf { it.isNotEmpty() }, runtimePaths = paths.takeIf { detail != null || it.isNotEmpty() }, titleValues = titles.takeIf { detail != null || it.isNotEmpty() }, piExtensions = extensions.takeIf { detail?.supportsPiExtensions == true }, codexAuth = codexAuth, presetId = presetId.takeIf { base == null }, presetModeId = mode?.id, presetEndpoint = endpoint))
    Scaffold(containerColor = LodyTheme.colors.bgBase, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(LodyIcons.Back, stringResource(R.string.settings_agent_back)) }
            Text(stringResource(if (base == null) R.string.settings_agent_add else R.string.settings_agent_edit), Modifier.weight(1f), style = LodyTheme.typography.headline)
            TextButton(enabled = editable && fields.valid && (base == null || detail != null), onClick = { onSave(fields) }) { Text(stringResource(R.string.settings_agent_save)) }
        }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(LodySpacing.lg), verticalArrangement = Arrangement.spacedBy(LodySpacing.lg)) {
            if (busy || loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (error != null) Text(providerError(error), style = LodyTheme.typography.footnote)
            if (failed) { Text(stringResource(R.string.settings_agent_load_failed)); TextButton(onClick = { tasks.launch { load() } }, enabled = !loading) { Text(stringResource(R.string.settings_agent_retry)) } }
            if (base == null) ProviderChoiceField(stringResource(R.string.settings_agent_providers), selection,
                catalog.map { ProviderChoice(it.id, it.name) } + presets.map { ProviderChoice("preset:${it.id}", it.name) }, editable) { id ->
                selection = id; envPatch = emptyMap(); paths = emptyMap(); titles = emptyMap(); endpoint = null; presetMode = null; codexAuth = null; extensions = emptyList()
                val p = presets.find { "preset:${it.id}" == id }; presetId = p?.id
                val c = catalog.find { it.id == id }
                cliType = p?.cliType ?: c?.cliType.orEmpty(); agentType = p?.agentType ?: c?.agentType.orEmpty()
                name = p?.name ?: c?.name.orEmpty()
            } else SettingsLine(base.agentType, LodyIcons.Agent, base.cliType)
            OutlinedTextField(name, { name = it }, enabled = editable, label = { Text(stringResource(R.string.settings_agent_name)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            if (cliType == "custom") {
                OutlinedTextField(command, { command = it }, enabled = editable, label = { Text(stringResource(R.string.settings_agent_command)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(arguments, { arguments = it }, enabled = editable, label = { Text(stringResource(R.string.settings_agent_arguments)) }, supportingText = { Text(stringResource(R.string.settings_agent_arguments_hint)) }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            }
            if (preset != null) {
                if (preset.modes.isNotEmpty()) ProviderChoiceField(stringResource(R.string.settings_agent_endpoint), mode?.id.orEmpty(), preset.modes.map { ProviderChoice(it.id, it.name) }, editable) { presetMode = it; endpoint = null }
                if (mode?.endpoints?.isNotEmpty() == true) ProviderChoiceField(stringResource(R.string.settings_agent_endpoint), endpoint ?: mode.endpoint.orEmpty(), mode.endpoints.map { ProviderChoice(it.url, it.name) }, editable) { endpoint = it }
                if (mode?.customEndpoint == true) OutlinedTextField(endpoint ?: mode.endpoint.orEmpty(), { endpoint = it }, enabled = editable, label = { Text(stringResource(R.string.settings_agent_endpoint)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(envPatch[preset.tokenEnvKey].orEmpty(), { envPatch = envPatch + (preset.tokenEnvKey to it) }, enabled = editable,
                    label = { Text(stringResource(R.string.settings_agent_api_key)) }, modifier = Modifier.fillMaxWidth(), singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false))
            }
            detail?.endpoints?.forEach { (key, original) -> OutlinedTextField(envPatch[key] ?: original, { envPatch = envPatch + (key to it) }, enabled = editable,
                label = { Text(key) }, modifier = Modifier.fillMaxWidth(), singleLine = true) }
            if (base != null && detail != null) {
                TextButton(enabled = editable, onClick = { tasks.launch {
                    loading = true; failed = false
                    try { capabilities = service.probe(scope, machineId, editor.id).capabilities }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { failed = true }
                    finally { loading = false }
                } }) { Text(stringResource(R.string.settings_agent_test)) }
                TextButton(enabled = editable && !refreshing, onClick = { tasks.launch {
                    refreshing = true; refreshProgress = null; refreshResult = null
                    refreshResult = try {
                        val result = service.refreshModels(scope, machineId, editor.id)
                        capabilities = result.capabilities
                        when { result.authRequired -> R.string.settings_agent_auth_required; result.success -> R.string.settings_agent_refresh_done; else -> R.string.settings_agent_write_unknown }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { R.string.settings_agent_write_unknown }
                    finally { refreshing = false; refreshProgress = null }
                } }) { Text(stringResource(R.string.settings_agent_refresh_models)) }
                if (refreshing) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                    CircularProgressIndicator(Modifier.size(LodyIconSize.sm), color = LodyTheme.colors.textSecondary)
                    Text(refreshLine(refreshProgress), style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary)
                } else refreshResult?.let { Text(stringResource(it), style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary) }
                ProviderAuthentication(service, scope, machineId, editor.id, detail!!, editable)

            }
            if (detail != null || (base == null && cliType in setOf("builtin", "registry"))) key(cliType, agentType) {
                ProviderRuntimeControls(service, scope, machineId, base?.id, detail, cliType, agentType, supportsPiExtensions, editable, extensions) { extensions = it }
            }
            if ((detail?.supportsCodexProfiles ?: supportsCodexProfiles) && agentType == "codex") {
                    ProviderChoiceField(stringResource(R.string.settings_agent_auth_method), codexAuth?.mode ?: "chatgpt", listOf(ProviderChoice("chatgpt", "ChatGPT"), ProviderChoice("api-key", stringResource(R.string.settings_agent_api_key_short))), editable) {
                        codexAuth = ProviderCodexAuth(it, codexAuth?.profileId ?: java.util.UUID.randomUUID().toString(), if (it == "api-key") codexAuth?.baseUrl ?: "https://api.openai.com/v1" else null)
                    }
                    if (codexAuth?.mode == "api-key") OutlinedTextField(codexAuth?.baseUrl.orEmpty(), { codexAuth = codexAuth?.copy(baseUrl = it) }, enabled = editable, label = { Text(stringResource(R.string.settings_agent_endpoint)) }, modifier = Modifier.fillMaxWidth())
                }
            OutlinedTextField(description, { description = it }, enabled = editable, label = { Text(stringResource(R.string.settings_agent_description)) }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(prompt, { prompt = it }, enabled = editable, label = { Text(stringResource(R.string.settings_agent_prompt)) }, modifier = Modifier.fillMaxWidth(), minLines = 3)
            ProviderEnvironment(detail?.envKeys.orEmpty().filterNot { it in preset?.protectedEnvKeys.orEmpty() }, envPatch.filterKeys { it !in preset?.protectedEnvKeys.orEmpty() }, editable) { changed ->
                envPatch = envPatch.filterKeys { it in preset?.protectedEnvKeys.orEmpty() } + changed
            }
            val pathKey = if (cliType == "builtin") mapOf("codex" to "codexPath", "claude" to "claudeCodeExecutable", "kimi" to "kimiPath", "grok" to "grokPath", "devin" to "devinPath", "pi" to "piPath")[agentType] else null
            if (pathKey != null) OutlinedTextField(paths[pathKey].orEmpty(), { paths = paths + (pathKey to it.takeIf(String::isNotBlank)) }, enabled = editable,
                label = { Text(stringResource(R.string.settings_agent_runtime_path)) }, supportingText = { Text(stringResource(R.string.settings_agent_runtime_path_hint)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            if (!capabilities.sessionTitle) {
                Text(stringResource(R.string.settings_agent_title_generation), style = LodyTheme.typography.body)
                val selectors = capabilities.options.ifEmpty {
                    listOfNotNull(capabilities.models.takeIf { it.isNotEmpty() }?.let { ProviderOption("model", stringResource(R.string.settings_agent_model), "select", null, null, it) },
                        capabilities.modes.takeIf { it.isNotEmpty() }?.let { ProviderOption("mode", stringResource(R.string.settings_agent_mode), "select", null, null, it) })
                }
                if (selectors.isEmpty()) Text(stringResource(R.string.settings_agent_test_hint), style = LodyTheme.typography.footnote)
                selectors.forEach { option ->
                    if (option.type == "boolean") Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(option.name, Modifier.weight(1f)); Switch(checked = titles[option.id] as? Boolean ?: option.booleanValue ?: false, enabled = editable, onCheckedChange = { titles = titles + (option.id to it) })
                    } else ProviderChoiceField(option.name, titles[option.id] as? String ?: option.value.orEmpty(), option.choices, editable) { titles = titles + (option.id to it) }
                }
            }
        }
    }
}
