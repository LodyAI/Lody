package app.lody.android.chat

import app.lody.android.designsystem.LodyIconButton as IconButton
import app.lody.android.designsystem.LodyTextButton as TextButton

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.*
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

internal fun messageWorkSeconds(message: SessionMessage): Long? {
    if (message.streaming) return null
    val start = message.timestamp?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: message.startedAt ?: return null
    val end = message.endedAt ?: return null
    if (end < start) return null
    return ((end - start - message.permissionWaitMs.coerceAtLeast(0)).coerceAtLeast(0)) / 1000
}

data class MessageActionState(
    val editable: String? = null,
    val edit: (String) -> Unit = {},
    val info: (String) -> Unit = {},
    val fork: (String) -> Unit = {},
)

@Composable
internal fun MessageActionButton(icon: ImageVector, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(LodySize.controlLg)) {
        Icon(icon, label, modifier = Modifier.size(LodyIconSize.sm), tint = if (enabled) LodyTheme.colors.iconSecondary else LodyTheme.colors.iconTertiary)
    }
}

@Composable
internal fun MessageCopyButton(text: String) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(text) { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1600); copied = false } }
    MessageActionButton(if (copied) LodyIcons.Check else LodyIcons.Copy, stringResource(if (copied) R.string.message_copied else R.string.message_copy), text.isNotBlank()) {
        clipboard.setText(AnnotatedString(text)); copied = true
    }
}

/** Reads eligibility from the current replica; mutations are never replayed after uncertain delivery. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun rememberMessageActions(
    repository: ChatRepository, scope: RuntimeScope, sessionId: String, messages: List<SessionMessage>,
    enabled: Boolean, onOpen: (String) -> Unit,
): MessageActionState {
    val tasks = rememberCoroutineScope()
    val latest = messages.lastOrNull { it.role == "user" }
    var editable by remember(sessionId) { mutableStateOf<String?>(null) }
    fun editPayload(id: String) = JSONObject().put("action", "read").put("sessionId", sessionId).put("expectedUserTurnId", id)
    LaunchedEffect(sessionId, latest, enabled, messages.lastOrNull()?.streaming) {
        editable = null
        if (enabled && latest != null) {
            try { if (repository.messageAction(scope, "edit", editPayload(latest.id)).optString("state") == "ready") editable = latest.id }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { }
        }
    }
    var info by remember(sessionId) { mutableStateOf<String?>(null) }
    var editing by remember(sessionId) { mutableStateOf<String?>(null) }
    var draft by remember(sessionId) { mutableStateOf("") }
    var originals by remember(sessionId) { mutableStateOf(JSONArray()) }
    var forking by remember(sessionId) { mutableStateOf<String?>(null) }
    var forkTarget by remember(sessionId) { mutableStateOf("") }
    var busy by remember(sessionId) { mutableStateOf(false) }
    var ready by remember(sessionId) { mutableStateOf(false) }
    var outcome by remember(sessionId) { mutableStateOf("") }
    val failed = stringResource(R.string.message_unavailable)
    val unknown = stringResource(R.string.message_unknown)
    fun load(kind: String, id: String) {
        if (busy) return
        ready = false; outcome = ""; busy = true
        if (kind == "edit") editing = id else { forking = id; forkTarget = UUID.randomUUID().toString() }
        tasks.launch {
            try {
                val payload = if (kind == "edit") editPayload(id) else JSONObject().put("action", "read").put("sourceSessionId", sessionId).put("sourceTurnId", id)
                val result = repository.messageAction(scope, kind, payload)
                ready = result.optString("state") == "ready"
                if (ready && kind == "edit") { draft = result.optString("text"); originals = result.optJSONArray("attachments") ?: JSONArray() }
                if (!ready) outcome = failed
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { outcome = failed }
            finally { busy = false }
        }
    }
    info?.let { id ->
        val message = messages.firstOrNull { it.id == id }
        ModalBottomSheet(onDismissRequest = { info = null }, containerColor = LodyTheme.colors.bgBase) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(LodySpacing.lg), verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
                Text(stringResource(R.string.message_info), style = LodyTheme.typography.headline)
                val labels = mapOf("modelId" to R.string.message_model, "name" to R.string.message_model, "thoughtLevel" to R.string.message_reasoning, "modeId" to R.string.message_mode, "inputTokens" to R.string.message_input_tokens, "outputTokens" to R.string.message_output_tokens, "reasoningOutputTokens" to R.string.message_reasoning_tokens, "cacheReadInputTokens" to R.string.message_cache_read, "cacheCreationInputTokens" to R.string.message_cache_write)
                val metadata = message?.metadata.orEmpty().filterKeys { it != "modelId" || message?.metadata?.containsKey("name") != true }
                if (metadata.isEmpty()) Text(stringResource(R.string.message_no_info), color = LodyTheme.colors.textSecondary)
                metadata.forEach { (key, value) -> labels[key]?.let { label ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(stringResource(label), modifier = Modifier.weight(1f), color = LodyTheme.colors.textSecondary)
                        Text(value, modifier = Modifier.weight(1f), style = LodyTheme.typography.body)
                    }
                } }
                Spacer(Modifier.height(LodySpacing.xl))
            }
        }
    }
    val active = editing ?: forking
    if (active != null) {
        val edit = editing != null
        AlertDialog(
            onDismissRequest = { if (!busy) { editing = null; forking = null } },
            title = { Text(stringResource(if (edit) R.string.message_edit else R.string.message_fork)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
                    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                    if (edit && ready) {
                        OutlinedTextField(draft, { if (it.length <= 32000) draft = it }, enabled = !busy && outcome != unknown, minLines = 3, maxLines = 8, modifier = Modifier.fillMaxWidth())
                        if (originals.length() > 0) Text(stringResource(R.string.message_keep_attachments, originals.length()), style = LodyTheme.typography.footnote)
                    } else if (!edit) Text(stringResource(R.string.message_fork_explanation))
                    if (outcome.isNotEmpty()) Text(outcome, color = LodyTheme.colors.textSecondary)
                }
            },
            dismissButton = { TextButton(onClick = { editing = null; forking = null }, enabled = !busy) { Text(stringResource(R.string.message_close)) } },
            confirmButton = { TextButton(enabled = ready && !busy && outcome != unknown && (!edit || draft.isNotBlank() || originals.length() > 0), onClick = {
                busy = true
                val request = if (edit) editPayload(active).put("action", "send").put("id", UUID.randomUUID().toString()).put("text", draft).put("retainedIds", JSONArray((0 until originals.length()).map { originals.getJSONObject(it).getString("editId") }))
                    else JSONObject().put("action", "send").put("sourceSessionId", sessionId).put("sourceTurnId", active).put("targetSessionId", forkTarget)
                tasks.launch {
                    try {
                        val result = repository.messageAction(scope, if (edit) "edit" else "fork", request).optString("state")
                        if (result in setOf("accepted", "created")) {
                            editing = null; forking = null
                            if (!edit) onOpen(forkTarget)
                        } else { outcome = if (result in setOf("not_sent", "rejected")) failed else unknown; ready = false }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { outcome = unknown; ready = false }
                    finally { busy = false }
                }
            }) { Text(stringResource(if (edit) R.string.message_save_resend else R.string.message_fork)) } },
        )
    }
    return MessageActionState(editable, { load("edit", it) }, { info = it }, { load("fork", it) })
}
