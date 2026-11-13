// Remote previews of a conversation: the managed web preview (a dev server the agent reported)
// and iOS Simulator / Android Emulator screens streamed from the session's computer. Web counterpart:
// `session-ios-simulator-panel.tsx`; iOS: SessionController+Tools / SimulatorController.

package app.lody.android.chat

import app.lody.android.designsystem.LodyIconButton as IconButton
import app.lody.android.designsystem.LodyTextButton as TextButton

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.DevicePlatform
import app.lody.android.runtime.PreviewDevice
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Copy for an in-band preview error code (runtime `sessionPreview` / device control). */
@Composable
internal fun previewErrorText(code: String?, message: String?): String = when (code) {
    "unsupported" -> stringResource(R.string.preview_unsupported)
    "unauthorized", "backend_rejected", "forbidden" -> stringResource(R.string.preview_unauthorized)
    "timeout" -> stringResource(R.string.preview_timeout)
    else -> message?.takeIf { it.isNotBlank() } ?: stringResource(R.string.preview_generic)
}

@Composable
private fun FullScreenPage(onClose: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler(onBack = onClose)
        Column(Modifier.fillMaxSize().background(LodyTheme.colors.bgBase).statusBarsPadding().navigationBarsPadding(), content = content)
    }
}

@Composable
private fun PageBar(title: String, subtitle: String?, onClose: () -> Unit, actions: @Composable RowScope.() -> Unit) {
    val colors = LodyTheme.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = LodySpacing.xs, vertical = LodySpacing.xs), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onClose) { Icon(LodyIcons.Close, stringResource(R.string.preview_close), tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md)) }
        Column(Modifier.weight(1f).padding(horizontal = LodySpacing.xs)) {
            Text(title, style = LodyTheme.typography.bodyEmphasis, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrBlank()) Text(subtitle, style = LodyTheme.typography.footnote, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        actions()
    }
}

/** The managed web preview's page: the link in a WebView, with Stop, Copy link and Open in browser. */
@Composable
internal fun BrowserPreviewPage(label: String, url: String, stopping: Boolean, onStop: () -> Unit, onCopy: () -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val colors = LodyTheme.colors
    var title by remember(url) { mutableStateOf(label) }
    FullScreenPage(onClose) {
        PageBar(title, label.takeIf { it != title }, onClose) {
            var menu by remember { mutableStateOf(false) }
            Box {
                IconButton(onClick = { menu = true }) { Icon(LodyIcons.More, stringResource(R.string.bar_more), tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md)) }
                DropdownMenu(menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.preview_open_browser)) }, leadingIcon = { Icon(LodyIcons.ExternalLink, null) },
                        onClick = { menu = false; openExternal(context, url) })
                    DropdownMenuItem(text = { Text(stringResource(R.string.preview_copy_link)) }, leadingIcon = { Icon(LodyIcons.Link, null) },
                        onClick = { menu = false; onCopy() })
                    DropdownMenuItem(text = { Text(stringResource(R.string.preview_stop), color = colors.dangerDefault) }, enabled = !stopping,
                        leadingIcon = { Icon(LodyIcons.Stop, null, tint = colors.dangerDefault) }, onClick = { menu = false; onStop() })
                }
            }
        }
        BrowserPreviewWebView(url, Modifier.weight(1f).fillMaxWidth()) { title = it }
    }
}

/** A device preview capsule in the action bar; tapping opens the device page (resume or picker). */
@Composable
internal fun DevicePreviewChip(platform: DevicePlatform, preview: DevicePreviewSession, onOpen: () -> Unit) {
    val colors = LodyTheme.colors
    val label = preview.name.takeIf { preview.running && it.isNotEmpty() }
        ?: stringResource(if (platform == DevicePlatform.IOS) R.string.preview_ios else R.string.preview_android)
    Box(
        Modifier.size(36.dp).clip(CircleShape).background(colors.bgRaised)
            .border(0.5.dp, colors.borderSubtle, CircleShape)
            .clickable(role = Role.Button, onClickLabel = label, onClick = onOpen)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (preview.connecting) CircularProgressIndicator(Modifier.size(LodyIconSize.sm), strokeWidth = 2.dp, color = colors.iconSecondary)
        else Icon(if (platform == DevicePlatform.IOS) LodyIcons.Machine else LodyIcons.Desktop, null, tint = colors.accentFg, modifier = Modifier.size(LodyIconSize.sm))
    }
}

/** A device control the toolbar sends through the viewer (shared `DevicePreviewControl`). */
private data class ToolbarControl(val label: Int, val control: JSONObject)

private fun button(name: String) = JSONObject().put("kind", "button").put("button", name)
private fun rotate(direction: String) = JSONObject().put("kind", "rotate").put("direction", direction)
private fun appearance(value: String) = JSONObject().put("kind", "appearance").put("appearance", value)

private fun controls(platform: DevicePlatform): List<ToolbarControl> = when (platform) {
    DevicePlatform.ANDROID -> listOf(
        ToolbarControl(R.string.preview_ctl_back, button("back")),
        ToolbarControl(R.string.preview_ctl_home, button("home")),
        ToolbarControl(R.string.preview_ctl_recents, button("app-switcher")),
        ToolbarControl(R.string.preview_ctl_rotate_left, rotate("left")),
        ToolbarControl(R.string.preview_ctl_rotate_right, rotate("right")),
        ToolbarControl(R.string.preview_ctl_light, appearance("light")),
        ToolbarControl(R.string.preview_ctl_dark, appearance("dark")),
    )
    DevicePlatform.IOS -> listOf(
        ToolbarControl(R.string.preview_ctl_home, button("home")),
        ToolbarControl(R.string.preview_ctl_app_switcher, button("app-switcher")),
        ToolbarControl(R.string.preview_ctl_lock, button("lock")),
        ToolbarControl(R.string.preview_ctl_volume_up, button("volume-up")),
        ToolbarControl(R.string.preview_ctl_volume_down, button("volume-down")),
        ToolbarControl(R.string.preview_ctl_rotate_left, rotate("left")),
        ToolbarControl(R.string.preview_ctl_rotate_right, rotate("right")),
        ToolbarControl(R.string.preview_ctl_shake, JSONObject().put("kind", "shake")),
        ToolbarControl(R.string.preview_ctl_light, appearance("light")),
        ToolbarControl(R.string.preview_ctl_dark, appearance("dark")),
    )
}

/** Web's limits: text up to 4096 characters; a URL or deep link that never executes or reads local files. */
internal object DeviceInput {
    private val refused = setOf("javascript", "data", "file", "vbscript", "blob", "about")
    fun textValid(text: String) = text.isNotEmpty() && text.length <= 4096
    fun urlValid(input: String): Boolean {
        val url = input.trim()
        if (url.isEmpty() || url.length > 2048 || url.any { it.code <= 32 || it.code == 127 }) return false
        val scheme = url.substringBefore(':', "").lowercase()
        return Regex("^[a-z][a-z0-9+.-]*$").matches(scheme) && scheme !in refused && url.length > scheme.length + 1
    }
}

/**
 * One device preview, full screen: resume or pick a device, wait while it starts, then the screen
 * with its controls. Closing the page leaves the device running; Stop ends it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DevicePreviewPage(session: DevicePreviewSession, onClose: () -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val snackbar = remember { SnackbarHostState() }
    val coroutines = rememberCoroutineScope()
    LaunchedEffect(session) { session.open() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> foreground = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val platformName = stringResource(if (session.platform == DevicePlatform.IOS) R.string.preview_ios else R.string.preview_android)
    val phaseText = stringResource(when (session.phase) {
        "preparing", "booting" -> R.string.preview_phase_starting
        "connecting" -> R.string.preview_phase_connecting
        "ready" -> R.string.preview_phase_ready
        "failed" -> R.string.preview_phase_failed
        else -> R.string.preview_phase_closed
    })
    val stopFailed = stringResource(R.string.preview_stop_failed)
    val controlErrors = mapOf(
        "unavailable" to stringResource(R.string.preview_control_unavailable),
        "busy" to stringResource(R.string.preview_control_busy),
        "unsupported" to stringResource(R.string.preview_control_unsupported),
    )
    val controlFailed = stringResource(R.string.preview_control_failed)
    val bridge = remember(session) { DeviceViewerBridge() }
    val sendControl: (JSONObject) -> Unit = { control ->
        coroutines.launch {
            val error = bridge.control(control) ?: return@launch
            snackbar.currentSnackbarData?.dismiss()
            snackbar.showSnackbar(controlErrors[error] ?: controlFailed)
        }
    }
    var input by remember { mutableStateOf<String?>(null) } // "text" / "url"
    FullScreenPage(onClose) {
        PageBar(if (session.running && session.name.isNotBlank()) session.name else platformName,
            if (session.running) phaseText else if (session.name.isNotBlank()) platformName else null, onClose) {
            if (session.platform == DevicePlatform.ANDROID && session.running) {
                var menu by remember { mutableStateOf(false) }
                Box {
                    TextButton(onClick = { menu = true }) { Text(stringResource(qualityLabel(session.quality)), color = colors.textPrimary) }
                    DropdownMenu(menu, onDismissRequest = { menu = false }) {
                        Text(stringResource(R.string.preview_quality), style = type.footnote, color = colors.textSecondary,
                            modifier = Modifier.padding(horizontal = LodySpacing.lg, vertical = LodySpacing.xs))
                        listOf("saver", "balanced", "clear").forEach { value ->
                            DropdownMenuItem(text = { Text(stringResource(qualityLabel(value))) },
                                trailingIcon = { if (value == session.quality) Icon(LodyIcons.Check, null) },
                                onClick = { menu = false; session.changeQuality(value) })
                        }
                    }
                }
            }
            if (session.running) TextButton(onClick = {
                session.stop { coroutines.launch { snackbar.showSnackbar(stopFailed) } }
            }) { Text(stringResource(R.string.preview_stop), color = colors.dangerDefault) }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            val viewerUrl = session.viewerUrl
            val operationId = session.preview?.operationId
            when {
                session.loading -> Waiting(stringResource(R.string.preview_checking))
                viewerUrl != null && operationId != null -> DeviceScreen(session.platform, viewerUrl, operationId, foreground, bridge)
                session.running -> Waiting(phaseText)
                else -> DevicePicker(session)
            }
            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
        }
        if (session.viewerUrl != null) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = LodySpacing.md, vertical = LodySpacing.sm),
                horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
            ) {
                controls(session.platform).forEach { item -> ControlCapsule(stringResource(item.label)) { sendControl(item.control) } }
                ControlCapsule(stringResource(R.string.preview_ctl_paste)) { input = "text" }
                if (session.platform == DevicePlatform.IOS) ControlCapsule(stringResource(R.string.preview_ctl_open_url)) { input = "url" }
            }
        }
    }
    input?.let { kind ->
        DeviceInputDialog(kind == "url", onDismiss = { input = null }) { value ->
            input = null
            sendControl(if (kind == "url") JSONObject().put("kind", "open-url").put("url", value.trim()) else JSONObject().put("kind", "text").put("text", value))
        }
    }
}

private fun qualityLabel(value: String) = when (value) {
    "saver" -> R.string.preview_quality_saver
    "clear" -> R.string.preview_quality_clear
    else -> R.string.preview_quality_balanced
}

@Composable
private fun ControlCapsule(label: String, onClick: () -> Unit) {
    val colors = LodyTheme.colors
    Box(
        Modifier.heightIn(min = LodySize.controlMd).clip(CircleShape).background(colors.bgRaised).border(0.5.dp, colors.borderSubtle, CircleShape)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = LodySpacing.lg),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = LodyTheme.typography.subhead, color = colors.textPrimary, maxLines = 1) }
}

@Composable
private fun BoxScope.Waiting(text: String) {
    Column(Modifier.align(Alignment.Center).padding(LodySpacing.xl), horizontalAlignment = Alignment.CenterHorizontally) {
        LodyLoadingIndicator(Modifier.size(LodySize.controlLg))
        Spacer(Modifier.height(LodySpacing.md))
        Text(text, style = LodyTheme.typography.body, color = LodyTheme.colors.textSecondary)
    }
}

/** The streamed screen, fitted whole inside the page (no bezel on Android). */
@Composable
private fun BoxScope.DeviceScreen(platform: DevicePlatform, viewerUrl: String, operationId: String, visible: Boolean, bridge: DeviceViewerBridge) {
    var state by remember(viewerUrl, operationId) { mutableStateOf(ViewerState("connecting")) }
    var reload by remember(viewerUrl, operationId) { mutableIntStateOf(0) }
    val ratio = if (state.width > 0 && state.height > 0) state.width.toFloat() / state.height else if (platform == DevicePlatform.IOS) 0.46f else 0.45f
    BoxWithConstraints(Modifier.fillMaxSize().padding(LodySpacing.md), contentAlignment = Alignment.Center) {
        val wide = maxHeight.value > 0f && ratio > maxWidth.value / maxHeight.value
        val width = if (wide) maxWidth else maxHeight * ratio
        val height = if (wide) maxWidth / ratio else maxHeight
        Box(Modifier.size(width, height).clip(RoundedCornerShape(LodyRadius.xl)).background(LodyTheme.colors.bgSunken)) {
            key(reload) {
                DeviceViewerWebView(viewerUrl, operationId, visible, bridge, Modifier.fillMaxSize()) { state = it }
            }
        }
    }
    if (state.state != "ready") {
        Column(Modifier.align(Alignment.Center).padding(LodySpacing.xl), horizontalAlignment = Alignment.CenterHorizontally) {
            if (state.state == "connecting") {
                LodyLoadingIndicator(Modifier.size(LodySize.controlLg))
                Spacer(Modifier.height(LodySpacing.md))
                Text(stringResource(R.string.preview_viewer_connecting), style = LodyTheme.typography.body, color = LodyTheme.colors.textSecondary)
            } else {
                Text(stringResource(if (state.state == "disconnected") R.string.preview_viewer_disconnected else R.string.preview_viewer_error),
                    style = LodyTheme.typography.body, color = LodyTheme.colors.textSecondary)
                TextButton(onClick = { state = ViewerState("connecting"); reload++ }) { Text(stringResource(R.string.preview_reload), color = LodyTheme.colors.accentFg) }
            }
        }
    }
}

@Composable
private fun DevicePicker(session: DevicePreviewSession) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val devices = session.devices.orEmpty()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = LodySpacing.lg, vertical = LodySpacing.md)) {
        session.failure?.let { failure ->
            item("failure") {
                Text(previewErrorText(failure.code, failure.detail), style = type.body, color = colors.dangerDefault, modifier = Modifier.padding(bottom = LodySpacing.md))
            }
        }
        item("header") {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.preview_devices), style = type.footnote, color = colors.textSecondary, modifier = Modifier.weight(1f))
                TextButton(onClick = { session.refreshDevices() }) { Text(stringResource(R.string.preview_refresh), color = colors.accentFg) }
            }
        }
        if (devices.isEmpty() && session.devices != null) item("empty") {
            Text(stringResource(R.string.preview_no_devices), style = type.body, color = colors.textSecondary, modifier = Modifier.padding(vertical = LodySpacing.md))
        }
        items(devices, key = { it.id }) { device -> DeviceRow(device) { session.start(device) } }
    }
}

@Composable
private fun DeviceRow(device: PreviewDevice, onStart: () -> Unit) {
    val colors = LodyTheme.colors
    val enabled = device.available && device.occupancy != "other-session"
    val note = when {
        device.occupancy == "other-session" -> stringResource(R.string.preview_device_busy)
        !device.available -> device.unavailableReason?.takeIf { it.isNotBlank() } ?: stringResource(R.string.preview_device_unavailable)
        device.occupancy == "this-session" -> stringResource(R.string.preview_device_here)
        else -> null
    }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(LodyRadius.md))
            .clickable(enabled = enabled, role = Role.Button, onClick = onStart)
            .padding(vertical = LodySpacing.md, horizontal = LodySpacing.sm),
    ) {
        Text(device.name, style = LodyTheme.typography.body, color = if (enabled) colors.textPrimary else colors.textDisabled, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val detail = listOf(device.runtime, device.deviceType.takeIf { it != device.name }.orEmpty()).filter { it.isNotBlank() }.joinToString(" · ")
        if (detail.isNotBlank()) Text(detail, style = LodyTheme.typography.footnote, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (note != null) Text(note, style = LodyTheme.typography.footnote, color = colors.textTertiary)
    }
}

@Composable
private fun DeviceInputDialog(url: Boolean, onDismiss: () -> Unit, onSend: (String) -> Unit) {
    var value by remember { mutableStateOf("") }
    val valid = if (url) DeviceInput.urlValid(value) else DeviceInput.textValid(value)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (url) R.string.preview_url_title else R.string.preview_text_title)) },
        text = {
            OutlinedTextField(value, { value = it }, singleLine = url, modifier = Modifier.fillMaxWidth(),
                isError = value.isNotEmpty() && !valid,
                supportingText = { if (value.isNotEmpty() && !valid) Text(stringResource(if (url) R.string.preview_url_invalid else R.string.preview_text_too_long)) })
        },
        confirmButton = { TextButton(onClick = { onSend(value) }, enabled = valid) { Text(stringResource(R.string.preview_send)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.preview_cancel)) } },
    )
}

