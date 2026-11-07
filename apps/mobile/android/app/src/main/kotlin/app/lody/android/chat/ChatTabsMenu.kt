package app.lody.android.chat

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.CatalogSession
import kotlin.math.roundToInt

@Composable
fun ChatTabsMenu(tabs: List<CatalogSession>, closed: List<CatalogSession>, currentId: String,
                 creating: Boolean, busy: String?, onSelect: (String) -> Unit, onNew: () -> Unit,
                 onClose: (String) -> Unit, onRestore: (String) -> Unit) {
    var history by remember { mutableStateOf(false) }
    BackHandler(history) { history = false }
    AnimatedContent(history, transitionSpec = {
        val direction = if (targetState) 1 else -1
        (slideInHorizontally(tween(220)) { direction * it } + fadeIn(tween(180))) togetherWith
            (slideOutHorizontally(tween(220)) { -direction * it } + fadeOut(tween(180)))
    }, label = "tabList") { showingClosed ->
        Column(Modifier.width(320.dp).clipToBounds()) {
            if (showingClosed) {
                DropdownMenuItem(text = { Text(stringResource(R.string.chat_closed_tabs)) },
                    leadingIcon = { Icon(LodyIcons.Back, stringResource(R.string.chat_back)) }, onClick = { history = false })
                HorizontalDivider(color = LodyTheme.colors.borderSubtle)
                if (closed.isEmpty()) Text(stringResource(R.string.chat_no_closed_tabs),
                    modifier = Modifier.padding(LodySpacing.lg), color = LodyTheme.colors.textSecondary, style = LodyTheme.typography.body)
                closed.forEach { tab ->
                    DropdownMenuItem(text = { Text(tab.title.ifBlank { stringResource(R.string.chat_new_tab_title) }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        enabled = busy == null,
                        trailingIcon = { if (busy == tab.id) CircularProgressIndicator(Modifier.size(LodyIconSize.md), strokeWidth = 2.dp)
                            else Icon(LodyIcons.Undo, stringResource(R.string.chat_restore_tab), tint = LodyTheme.colors.accentFg, modifier = Modifier.size(LodyIconSize.md)) },
                        onClick = { onRestore(tab.id) })
                }
            } else {
                tabs.forEach { tab -> key(tab.id) {
                    SwipeTabRow(tab, tab.id == currentId, busy, { onSelect(tab.id) }, { onClose(tab.id) })
                } }
                HorizontalDivider(color = LodyTheme.colors.borderSubtle)
                DropdownMenuItem(text = { Text(stringResource(R.string.chat_new_tab), color = LodyTheme.colors.accentFg) },
                    enabled = !creating && busy == null, leadingIcon = { Icon(LodyIcons.Plus, null, tint = LodyTheme.colors.accentFg, modifier = Modifier.size(LodyIconSize.md)) }, onClick = onNew)
                DropdownMenuItem(text = { Text(stringResource(R.string.chat_closed_tabs), color = LodyTheme.colors.textSecondary) },
                    leadingIcon = { Icon(LodyIcons.Sessions, null, tint = LodyTheme.colors.textSecondary, modifier = Modifier.size(LodyIconSize.md)) },
                    trailingIcon = { Icon(LodyIcons.Forward, null, tint = LodyTheme.colors.textSecondary, modifier = Modifier.size(LodyIconSize.sm)) }, onClick = { history = true })
            }
        }
    }
}

@Composable
private fun SwipeTabRow(tab: CatalogSession, current: Boolean, busy: String?, onSelect: () -> Unit, onClose: () -> Unit) {
    val width = with(LocalDensity.current) { 76.dp.toPx() }
    var reveal by remember { mutableStateOf(false) }
    var drag by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    val target = if (dragging) drag else if (reveal) -width else 0f
    val offset by animateFloatAsState(target, tween(if (dragging) 0 else 160), label = "tabSwipe")
    val close = stringResource(R.string.chat_close_tab)
    val colors = LodyTheme.colors
    Box(Modifier.fillMaxWidth().clipToBounds()) {
        Box(Modifier.align(Alignment.CenterEnd).width(76.dp).heightIn(min = LodySize.listRow)
            .background(MaterialTheme.colorScheme.error).clickable(enabled = busy == null && reveal, onClick = onClose), contentAlignment = Alignment.Center) {
            if (offset < -1f) Text(close, color = MaterialTheme.colorScheme.onError, style = LodyTheme.typography.body)
        }
        Row(Modifier.fillMaxWidth().offset { IntOffset(offset.roundToInt(), 0) }.background(colors.bgOverlay)
            .pointerInput(width, busy) {
                if (busy == null) detectHorizontalDragGestures(
                    onDragStart = { drag = if (reveal) -width else 0f; dragging = true },
                    onDragEnd = { reveal = drag < -width / 2; dragging = false },
                    onDragCancel = { dragging = false },
                    onHorizontalDrag = { change, amount -> change.consume(); drag = (drag + amount).coerceIn(-width, 0f) })
            }.semantics { customActions = listOf(CustomAccessibilityAction(close) { if (busy == null) { onClose(); true } else false }) }
            .clickable(enabled = busy == null) { if (reveal) reveal = false else onSelect() }
            .heightIn(min = LodySize.listRow).padding(horizontal = LodySpacing.lg),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
            Box(Modifier.size(LodyIconSize.md)) { DirectoryTabs.attention(listOf(tab))?.let { app.lody.android.home.AttentionGlyph(it) } }
            Text(tab.title.ifBlank { stringResource(R.string.chat_new_tab_title) }, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = LodyTheme.typography.body, color = colors.textPrimary)
            if (busy == tab.id) CircularProgressIndicator(Modifier.size(LodyIconSize.sm), strokeWidth = 2.dp)
            else if (current) Icon(LodyIcons.Check, stringResource(R.string.chat_current_tab), tint = colors.accentFg, modifier = Modifier.size(LodyIconSize.sm))
        }
    }
}
