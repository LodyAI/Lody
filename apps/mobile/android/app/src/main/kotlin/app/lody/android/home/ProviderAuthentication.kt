package app.lody.android.home

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import java.net.URI
import java.util.UUID

@Composable
internal fun ProviderAuthentication(service: AgentProviderService, scope: RuntimeScope, machineId: String, id: String, detail: ProviderDetail, enabled: Boolean) {
    val tasks = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    var state by remember(id) { mutableStateOf<ProviderAuthState?>(null) }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var method by remember { mutableStateOf(detail.capabilities.authMethods.firstOrNull()?.id.orEmpty()) }
    var values by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var code by remember { mutableStateOf("") }
    fun act(action: String, response: String? = null) {
        if (busy) return
        val flowId = if (action == "start") UUID.randomUUID().toString() else state?.flowId ?: return
        val request = ProviderAuthRequest(machineId, id, action, flowId,
            methodId = method.takeIf { (action == "start" || state?.status == "method-required") && it.isNotBlank() }, interactionId = state?.interactionId.takeIf { action == "submit" },
            values = values.takeIf { action == "submit" && state?.status == "input-required" }, authorizationCode = code.takeIf { action == "submit" && state?.acceptsAuthorizationCode == true }, responseAction = response)
        if (action == "start") state = ProviderAuthState(flowId, "starting", emptyList(), emptyList(), null, null, null, false, null)
        tasks.launch {
            busy = true; failed = false
            try {
                val next = service.auth(scope, request)
                if (state?.interactionId != next.interactionId || next.status in listOf("authenticated", "cancelled", "error")) { values = emptyMap(); code = "" }
                if (next.methods.isNotEmpty() && next.methods.none { it.id == method }) method = next.methods.first().id
                state = next
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { failed = true }
            finally { busy = false }
        }
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(state?.flowId, enabled, lifecycleOwner) {
        if (enabled && state?.flowId != null) lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (state?.status !in listOf(null, "authenticated", "cancelled", "error")) {
                delay(1500)
                if (!busy && state?.status !in listOf(null, "authenticated", "cancelled", "error")) act("status")
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
        Text(stringResource(R.string.settings_agent_auth), style = LodyTheme.typography.body)
        if (!detail.supportsAuthentication) Text(stringResource(R.string.settings_agent_auth_unsupported), style = LodyTheme.typography.footnote)
        else {
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (failed || state?.status == "error") Text(stringResource(R.string.settings_agent_auth_failed), style = LodyTheme.typography.footnote)
            val active = state?.status !in listOf(null, "authenticated", "cancelled", "error")
            val methods = state?.methods?.takeIf { it.isNotEmpty() } ?: detail.capabilities.authMethods
            if ((detail.supportsMethodSelection || state?.status == "method-required" || state?.interactionId != null) && methods.isNotEmpty()) ProviderChoiceField(stringResource(R.string.settings_agent_auth_method), method, methods, enabled && !busy && (!active || state?.status == "method-required")) { method = it }
            if (state?.status == "authenticated") Text(stringResource(R.string.settings_agent_authenticated))
            if (!active) TextButton(enabled = enabled && !busy, onClick = { act("start") }) { Text(stringResource(R.string.settings_agent_sign_in)) }
            val flow = state
            if (flow != null && active) {
                flow.userCode?.let { Text(it) }
                flow.authorizationUrl?.let { url ->
                    val safe = runCatching { URI(url).let { it.scheme == "https" && it.host != null && it.userInfo == null } }.getOrDefault(false)
                    if (safe) TextButton(enabled = enabled && !busy && !flow.requiresAuthorizationConsent, onClick = { uriHandler.openUri(url) }) { Text(stringResource(R.string.settings_agent_open_sign_in)) }
                }
                if (flow.acceptsAuthorizationCode) OutlinedTextField(code, { code = it }, enabled = enabled && !busy, label = { Text(stringResource(R.string.settings_agent_authorization_code)) },
                    modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false))
                flow.fields.forEach { field ->
                    if (field.type == "select") ProviderChoiceField(field.label, values[field.id].orEmpty(), field.options, enabled && !busy) { values = values + (field.id to it) }
                    else OutlinedTextField(values[field.id].orEmpty(), { values = values + (field.id to it) }, enabled = enabled && !busy, label = { Text(field.label) }, modifier = Modifier.fillMaxWidth(),
                        visualTransformation = if (field.type == "secret") PasswordVisualTransformation() else VisualTransformation.None,
                        keyboardOptions = KeyboardOptions(keyboardType = if (field.type == "secret") KeyboardType.Password else KeyboardType.Text, autoCorrectEnabled = false))
                }
                Row {
                    if (flow.status == "method-required") TextButton(enabled = enabled && !busy && method.isNotBlank(), onClick = { act(if (flow.interactionId == null) "start" else "submit") }) { Text(stringResource(R.string.settings_agent_continue)) }
                    if (flow.requiresAuthorizationConsent) TextButton(enabled = enabled && !busy, onClick = { act("submit", "accept") }) { Text(stringResource(R.string.settings_agent_continue)) }
                    if (flow.status == "input-required" || flow.acceptsAuthorizationCode) TextButton(enabled = enabled && !busy && flow.fields.filter { it.required }.all { !values[it.id].isNullOrBlank() } && (!flow.acceptsAuthorizationCode || code.isNotBlank()), onClick = { act("submit") }) { Text(stringResource(R.string.settings_agent_continue)) }
                    TextButton(enabled = enabled && !busy, onClick = { act("status") }) { Text(stringResource(R.string.settings_agent_refresh)) }
                    TextButton(enabled = enabled && !busy, onClick = { act("cancel") }) { Text(stringResource(R.string.settings_agent_cancel)) }
                }
            }
        }
    }
}
