package app.lody.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.lody.android.home.ChatListModel
import app.lody.android.home.ChatAttention
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.CatalogSession

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionRelationsChip(current: String, sessions: List<CatalogSession>, navigate: (String) -> Unit) {
    val rows = remember(current, sessions) { SessionRelations.rows(current, sessions) }
    var open by remember(current) { mutableStateOf(false) }
    if (rows.isEmpty()) return
    val label = stringResource(R.string.chat_relations)
    // A raised capsule like the rest of the action bar; the glyph says "conversations", not git.
    val colors = LodyTheme.colors
    Box(
        Modifier.size(36.dp).clip(CircleShape).background(colors.bgRaised)
            .border(0.5.dp, colors.borderSubtle, CircleShape)
            .clickable(role = androidx.compose.ui.semantics.Role.Button, onClickLabel = label) { open = true },
        contentAlignment = androidx.compose.ui.Alignment.Center,
    ) {
        Icon(LodyIcons.Sessions, label, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
    }
    if (open) ModalBottomSheet(onDismissRequest = { open = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Text(label, Modifier.padding(LodySpacing.md), style = LodyTheme.typography.body)
        val depths = rows.map { it.depth.coerceAtMost(8) }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp).padding(horizontal = LodyLayout.screenPaddingX)) {
            itemsIndexed(rows, key = { _, row -> row.session.id }) { index, row ->
                val continuing = (1..depths[index]).filter { level ->
                    depths.drop(index + 1).firstOrNull { it <= level } == level
                }.toSet()
                ConversationBranch(depths[index], continuing) {
                    val members = listOf(row.session) + row.tabs
                    ConversationTabStrip(members.size) { memberIndex ->
                        val session = members[memberIndex]
                        val attention = ChatListModel.attention(session)
                        val status = when (attention) {
                            ChatAttention.Running -> stringResource(R.string.chat_operation_running)
                            ChatAttention.Failed -> stringResource(R.string.chat_operation_failed)
                            ChatAttention.Waiting -> stringResource(R.string.chat_relation_waiting)
                            ChatAttention.Unread -> stringResource(R.string.chat_relation_unread)
                            else -> null
                        }
                        RelatedConversationRow(
                            session = session,
                            title = session.title.ifBlank { stringResource(R.string.chat_operation_conversation) },
                            status = status, attention = attention, isCurrent = session.id == current,
                            enabled = SessionRelations.target(session.id, sessions) != null,
                            onClick = { if (SessionRelations.target(session.id, sessions) != null) { open = false; navigate(session.id) } },
                        )
                    }
                }
            }
        }
    }
}
