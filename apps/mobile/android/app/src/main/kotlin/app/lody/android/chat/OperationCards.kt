package app.lody.android.chat

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.lody.android.home.ChatAttention
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OperationCards(events: List<OperationEvent>, sessions: List<CatalogSession>, navigate: (String) -> Unit) {
    val colors = LodyTheme.colors
    var savedReply by remember { mutableStateOf<OperationCard?>(null) }
    savedReply?.let { card ->
        ModalBottomSheet(onDismissRequest = { savedReply = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = colors.bgBase) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(TranscriptMargin), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                Text(stringResource(R.string.chat_operation_full_reply), style = LodyTheme.typography.caption, color = colors.textSecondary)
                if (card.replyTruncated) Text(stringResource(R.string.chat_operation_reply_truncated), color = colors.textSecondary)
                SelectionContainer { MarkdownBlock(card.reply.orEmpty()) }
            }
        }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = TranscriptMargin), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
        events.forEach { event ->
            var expanded by remember(event.id) { mutableStateOf(false) }
            Column(Modifier.fillMaxWidth()) {
                if (event.memberCount != null) Text(stringResource(if (event.deliveryUnknown) R.string.chat_operation_batch_unknown else R.string.chat_operation_batch, event.memberCount), color = colors.textSecondary)
                if (event.cards.isNotEmpty()) Text(stringResource(if (event.creates) R.string.chat_operation_created else R.string.chat_operation_replies, event.cards.size), style = LodyTheme.typography.caption, color = colors.textSecondary)
                event.outcome?.let { outcome -> Text(stringResource(when (outcome) { "failed" -> R.string.chat_operation_failed; "cancelled" -> R.string.chat_operation_cancelled; else -> R.string.chat_operation_partial }), color = colors.textPrimary) }
                event.error?.let { Text(it, color = colors.textSecondary) }
                val visibleCards = if (expanded) event.cards else event.cards.take(5)
                val groups = visibleCards.groupBy { card ->
                    val session = sessions.firstOrNull { it.id == card.sessionId }
                    session?.parentSessionId ?: card.sessionId ?: card
                }.values.toList()
                groups.forEach { cards ->
                    ConversationTabStrip(cards.size) { cardIndex ->
                        val card = cards[cardIndex]
                        val target = SessionRelations.target(card.sessionId, sessions)
                        RelatedConversationRow(
                            session = target,
                            title = target?.title?.takeIf { it.isNotBlank() } ?: card.label ?: stringResource(R.string.chat_operation_conversation),
                            status = stringResource(when (card.status) { "created" -> R.string.chat_operation_ready; "running" -> R.string.chat_operation_running; "succeeded" -> R.string.chat_operation_succeeded; "failed" -> R.string.chat_operation_failed; else -> R.string.chat_operation_cancelled }),
                            attention = when (card.status) { "running" -> ChatAttention.Running; "failed" -> ChatAttention.Failed; else -> null },
                            enabled = target != null,
                            onClick = { SessionRelations.target(card.sessionId, sessions)?.let { navigate(it.id) } },
                        ) {
                            if (card.status == "cancelled") Text(stringResource(R.string.chat_operation_cancelled), style = LodyTheme.typography.caption, color = colors.textSecondary)
                            card.detail?.takeIf { it.isNotBlank() }?.let { Text(it.replace(Regex("\\s+"), " ").trim().take(240), maxLines = 3, overflow = TextOverflow.Ellipsis, color = colors.textSecondary) }
                            card.reply?.let { Text(it.replace(Regex("\\s+"), " ").trim().take(240), maxLines = 3, overflow = TextOverflow.Ellipsis, color = colors.textSecondary) }
                            if (card.replyTruncated) Text(stringResource(R.string.chat_operation_reply_truncated), style = LodyTheme.typography.caption, color = colors.textSecondary)
                            if (card.sessionId != null && target == null) Text(stringResource(R.string.chat_operation_unavailable), style = LodyTheme.typography.caption, color = colors.textSecondary)
                            if (card.reply != null) TextButton(onClick = { savedReply = card }) {
                                Text(stringResource(R.string.chat_operation_full_reply))
                            }
                        }
                    }
                }
                if (event.cards.size > 5) TextButton(onClick = { expanded = !expanded }) { Text(stringResource(if (expanded) R.string.chat_operation_less else R.string.chat_operation_more)) }
            }
        }
    }
}
