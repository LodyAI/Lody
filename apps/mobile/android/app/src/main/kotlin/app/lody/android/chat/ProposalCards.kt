package app.lody.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import app.lody.android.R
import app.lody.android.designsystem.LodyButton
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyLoadingIndicator
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyStroke
import app.lody.android.designsystem.LodyTextButton
import app.lody.android.designsystem.LodyTheme
import app.lody.android.runtime.ProposalCard
import app.lody.android.runtime.RuntimeException
import app.lody.android.runtime.TurnItem
import app.lody.android.schedules.ruleSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Long proposed text stays readable without turning the card into a page. */
private const val PreviewLimit = 600

/**
 * Save / create or dismiss an Agent's proposal; throws the runtime's failure. Null where there
 * is no runtime (previews, the stream probe): the cards then only describe the proposal.
 */
typealias ProposalDecider = suspend (ProposalCard, Boolean) -> Unit

/**
 * An Agent's Role or schedule proposals (web `AgentRoleProposalNotice` / `ScheduleProposalNotice`):
 * what saving or creating would do, then Dismiss and Save / Create; once decided, a receipt.
 * [meId] is the signed-in user: a Role proposal is decided only by the member who asked.
 */
@Composable
fun ProposalCards(proposals: List<ProposalCard>, meId: String?, decide: ProposalDecider?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = TranscriptMargin), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
        proposals.forEach { ProposalCardView(it, meId, decide) }
    }
}

@Composable
private fun ProposalCardView(card: ProposalCard, meId: String?, decide: ProposalDecider?) {
    val colors = LodyTheme.colors
    val scope = rememberCoroutineScope()
    var pending by remember(card.entryId, card.itemId) { mutableStateOf(false) }
    var failure by remember(card.entryId, card.itemId) { mutableStateOf<String?>(null) }
    // A decision recorded elsewhere (or by this card) ends any failure shown for it.
    LaunchedEffect(card.outcome) { if (card.decided) failure = null }
    val allowed = decide != null && !meId.isNullOrEmpty() && (!card.isRole || card.requesterUserId == meId)
    val shape = RoundedCornerShape(LodyRadius.xl)
    val submit: (Boolean) -> Unit = { accept ->
        if (!pending && allowed) {
            pending = true
            failure = null
            scope.launch {
                try { decide?.invoke(card, accept) }
                catch (error: CancellationException) { throw error }
                catch (error: RuntimeException) { failure = error.fault.code }
                catch (error: Exception) { failure = "failed" }
                finally { pending = false }
            }
        }
    }
    Column(
        Modifier.fillMaxWidth()
            .background(colors.bgRaised, shape)
            .border(LodyStroke.default, colors.borderSubtle, shape)
            .padding(LodySpacing.md),
        verticalArrangement = Arrangement.spacedBy(LodySpacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
            Icon(if (card.isRole) LodyIcons.Agent else LodyIcons.Clock, contentDescription = null,
                tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
            Text(headline(card), style = LodyTheme.typography.headline,
                color = if (card.decided) colors.textSecondary else colors.textPrimary)
        }
        if (card.isRole) RoleFields(card) else ScheduleFields(card)
        val note = when {
            failure != null -> failureText(failure!!)
            card.decided -> null
            decide != null && !allowed -> stringResource(R.string.chat_proposal_role_owner_only)
            card.isRole && card.action == "create" -> stringResource(R.string.chat_proposal_role_defaults)
            card.isRole -> stringResource(R.string.chat_proposal_role_scope)
            else -> null
        }
        note?.let {
            Text(it, style = LodyTheme.typography.footnote, color = if (failure != null) colors.dangerDefault else colors.textSecondary)
        }
        if (!card.decided && decide != null) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                LodyTextButton(onClick = { submit(false) }, enabled = allowed && !pending) {
                    Text(stringResource(R.string.chat_proposal_dismiss), color = colors.textPrimary)
                }
                Spacer(Modifier.width(LodySpacing.sm))
                LodyButton(
                    onClick = { submit(true) }, enabled = allowed && !pending, shape = CircleShape,
                    colors = ButtonDefaults.buttonColors(containerColor = colors.bgInverse, contentColor = colors.textInverse),
                ) {
                    if (pending) {
                        LodyLoadingIndicator(Modifier.size(LodyIconSize.sm), color = colors.textInverse)
                        Spacer(Modifier.width(LodySpacing.xs))
                    }
                    Text(stringResource(if (card.isRole) R.string.chat_proposal_save else R.string.chat_proposal_create))
                }
            }
        }
    }
}

@Composable
private fun headline(card: ProposalCard): String = stringResource(
    when {
        card.outcome == "dismissed" -> R.string.chat_proposal_dismissed
        card.isRole && card.outcome == "saved" -> R.string.chat_proposal_role_saved
        card.isRole && card.action == "update" -> R.string.chat_proposal_role_update
        card.isRole -> R.string.chat_proposal_role_create
        card.outcome == "created" -> R.string.chat_proposal_schedule_created
        else -> R.string.chat_proposal_schedule_title
    },
)

private fun clipped(value: String): String {
    val trimmed = value.trim()
    return if (trimmed.length > PreviewLimit) trimmed.take(PreviewLimit) + "…" else trimmed
}

@Composable
private fun Field(label: String, value: String, before: String? = null) {
    val colors = LodyTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.xxs)) {
        Text(label, style = LodyTheme.typography.caption, color = colors.textSecondary)
        before?.let {
            Text(it, style = LodyTheme.typography.subhead, color = colors.textSecondary, textDecoration = TextDecoration.LineThrough)
        }
        Text(value, style = LodyTheme.typography.subhead, color = colors.textPrimary)
    }
}

@Composable
private fun RoleFields(card: ProposalCard) {
    val empty = stringResource(R.string.chat_proposal_empty)
    val shown = { value: String? -> if (value.isNullOrEmpty()) empty else clipped(value) }
    listOf(
        Triple(R.string.chat_proposal_role_name, card.fields.name, card.before?.name),
        Triple(R.string.chat_proposal_role_description, card.fields.description, card.before?.description),
        Triple(R.string.chat_proposal_role_prompt_prefix, card.fields.promptPrefix, card.before?.promptPrefix),
    ).forEach { (label, value, before) ->
        if (value != null) Field(stringResource(label), shown(value), if (card.before != null) shown(before) else null)
    }
}

@Composable
private fun ScheduleFields(card: ProposalCard) {
    card.title?.let { Field(stringResource(R.string.chat_proposal_schedule_name), it) }
    card.rule?.let { Field(stringResource(R.string.chat_proposal_schedule_when), ruleSummary(it)) }
    destinationText(card.destination)?.let { Field(stringResource(R.string.chat_proposal_schedule_send_to), it) }
    if (!card.decided) card.prompt?.let { Field(stringResource(R.string.chat_proposal_schedule_prompt), clipped(it)) }
}

@Composable
private fun destinationText(destination: String?): String? = when (destination) {
    "new_session" -> stringResource(R.string.chat_proposal_destination_new)
    "own_session" -> stringResource(R.string.chat_proposal_destination_own)
    "existing_session" -> stringResource(R.string.chat_proposal_destination_existing)
    else -> null
}

@Composable
private fun failureText(code: String): String = stringResource(
    when (code) {
        "proposal_not_requester" -> R.string.chat_proposal_role_owner_only
        "proposal_unavailable" -> R.string.chat_proposal_error_unavailable
        "role_duplicate" -> R.string.chat_proposal_error_role_duplicate
        "role_read_only" -> R.string.chat_proposal_error_role_read_only
        "role_forbidden" -> R.string.chat_proposal_error_role_forbidden
        "role_target_unavailable" -> R.string.chat_proposal_error_role_target
        "schedule_target_unavailable" -> R.string.chat_proposal_error_schedule_target
        "schedule_not_owner" -> R.string.chat_proposal_error_schedule_owner
        "schedule_machine_unsupported" -> R.string.chat_proposal_error_schedule_unsupported
        "schedule_trigger_invalid" -> R.string.chat_proposal_error_schedule_trigger
        // Unknown and transport failures may have landed: say so instead of inviting a blind retry.
        else -> R.string.chat_proposal_error_failed
    },
)

/**
 * A file the agent shared (`lody_upload_files`, web `SessionFileCard`): a type glyph, its name,
 * and its type and size. Display only; Android has no session-file download yet.
 */
@Composable
fun AgentFileCard(item: TurnItem.File, modifier: Modifier = Modifier) {
    val colors = LodyTheme.colors
    val shape = RoundedCornerShape(LodyRadius.lg)
    val context = androidx.compose.ui.platform.LocalContext.current
    val extension = item.fileName.substringAfterLast('.', "").uppercase()
    val detail = listOfNotNull(
        extension.ifEmpty { null },
        item.sizeBytes?.let { android.text.format.Formatter.formatShortFileSize(context, it) },
    ).joinToString(" · ")
    val type = item.mimeType.orEmpty()
    val icon = when {
        type.startsWith("image/") -> LodyIcons.Image
        type.startsWith("text/") || extension.lowercase() in setOf("md", "txt", "log", "json", "yaml", "yml", "xml", "html", "csv") -> LodyIcons.FileCode
        else -> LodyIcons.File
    }
    Row(
        modifier.fillMaxWidth().padding(horizontal = TranscriptMargin).padding(bottom = LodySpacing.md)
            .background(colors.bgRaised, shape).border(LodyStroke.default, colors.borderSubtle, shape)
            .padding(LodySpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
    ) {
        Icon(icon, contentDescription = null, tint = colors.iconSecondary,
            modifier = Modifier.background(colors.fillTertiary, RoundedCornerShape(LodyRadius.md)).padding(LodySpacing.sm).size(LodyIconSize.sm))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(LodySpacing.xxs)) {
            Text(item.fileName, style = LodyTheme.typography.callout, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            if (detail.isNotEmpty()) Text(detail, style = LodyTheme.typography.caption, color = colors.textSecondary, maxLines = 1)
        }
    }
}
