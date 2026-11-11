package app.lody.android.chat

import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.combinedClickable
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.heightIn
import app.lody.android.designsystem.LodyWorkingGrid
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.lody.android.R
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodySize
import app.lody.android.home.Avatar
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.runtime.withFrameNanos
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import app.lody.android.runtime.TurnItem
import app.lody.android.runtime.StepDetail
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontStyle
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.highlightedCodeBlock
import com.mikepenz.markdown.compose.elements.highlightedCodeFence
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.rememberMarkdownState
import app.lody.android.designsystem.LodyLayout
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTheme

/** Who wrote a turn and when, for its header: avatar (or agent mark), name, time. */
data class TurnIdentity(val name: String, val image: String? = null, val time: String = "")

/** A user turn's delivery as web's `UserMessageSendStatus` shows it. */
enum class Delivery { Sending, Sent, Queued, Seen, Failed }

/** A transcript entry. Assistant replies render as Markdown blocks; user turns as plain text. */
sealed interface ChatEntry {
    val id: String

    /** A system entry: operation receipts and the Agent's Role / schedule proposals. */
    data class Operations(
        override val id: String, val events: List<app.lody.android.runtime.OperationEvent>,
        val proposals: List<app.lody.android.runtime.ProposalCard> = emptyList(),
    ) : ChatEntry

    data class User(
        override val id: String, val text: String, val who: TurnIdentity, val delivery: Delivery = Delivery.Sent,
        val attachments: List<app.lody.android.runtime.MessageAttachment> = emptyList(),
        val references: List<app.lody.android.runtime.MessageReference> = emptyList(),
    ) : ChatEntry
    /**
     * An agent turn laid out like web's: prose, thought / tool groups, and for a finished turn
     * the "Worked for …" fold above its answer ([TurnLayout]). [prose] holds each prose item's
     * Markdown blocks (answer text, DSH thoughts, proposed plans) by item id. Web shows no
     * identity on an agent turn; [worked] ("Worked for 8s") labels the fold.
     */
    data class Assistant(
        override val id: String,
        val layout: TurnLayout.Layout,
        val prose: Map<String, MarkdownBlocks>,
        val who: TurnIdentity,
        val worked: String = "",
        val working: Boolean = false,
        val files: List<app.lody.android.runtime.FileChange> = emptyList(),
        /** The session's provider (cliType, agentType); the footer leads with its mark. */
        val agentCliType: String? = null,
        val agentType: String? = null,
    ) : ChatEntry {
        companion object {
            /** A turn that is only prose (the stream probe, older projections). */
            fun prose(id: String, markdown: MarkdownBlocks, who: TurnIdentity, working: Boolean = false) = Assistant(
                id,
                TurnLayout.build(id, listOf(TurnItem.Text(id, "")), finished = !working, showThoughts = false),
                mapOf(id to markdown), who, working = working,
            )
        }
    }
}

/**
 * The chat transcript. Every Markdown block is its own lazy item keyed by message and
 * block index, so a streaming reply only re-renders its tail block. The list follows new
 * content while the reader is at the bottom and stops when they scroll up.
 */
@Composable
fun ChatTranscript(
    entries: List<ChatEntry>,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    state: LazyListState = rememberLazyListState(initialFirstVisibleItemIndex = Int.MAX_VALUE),
    scrollToLatest: Int = 0,
    actions: MessageActionState = MessageActionState(),
    relatedSessions: List<app.lody.android.runtime.CatalogSession> = emptyList(),
    navigateSession: (String) -> Unit = {},
    /** Opens a step's detail; null where there is no runtime (previews, the stream probe). */
    loadDetail: (suspend (entryId: String, itemId: String) -> StepDetail)? = null,
    /** Opens a changed file's diff for a turn; null where there is no runtime. */
    loadDiff: (suspend (entryId: String, path: String) -> app.lody.android.runtime.FileDiff)? = null,
    /** The signed-in user, who alone decides the Role proposals they asked for. */
    meId: String? = null,
    /** Decides an Agent's proposal; null where there is no runtime. */
    decideProposal: ProposalDecider? = null,
) {
    // Only an actual drag leaves follow mode. Programmatic positioning and IME layout
    // changes must not look like the reader scrolled away from the end.
    var following by remember(state) { mutableStateOf(true) }
    LaunchedEffect(state) {
        state.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) following = false
        }
    }
    LaunchedEffect(state) {
        snapshotFlow { state.isScrollInProgress to state.canScrollForward }
            .collect { (scrolling, more) -> if (scrolling && !more) following = true }
    }
    LaunchedEffect(state, scrollToLatest) {
        if (scrollToLatest == 0) return@LaunchedEffect
        following = true
        val last = state.layoutInfo.totalItemsCount - 1
        if (last >= 0) state.animateScrollToItem(last)
    }
    LaunchedEffect(state) {
        // Observe measured geometry, not the previous frame's item count. This also
        // follows growing text and each IME/composer resize while staying at the end.
        snapshotFlow {
            val layout = state.layoutInfo
            val tail = layout.visibleItemsInfo.lastOrNull()
            FollowLayout(following, state.isScrollInProgress, state.canScrollForward,
                layout.totalItemsCount, layout.viewportEndOffset, tail?.index, tail?.offset, tail?.size)
        }.collect { layout ->
            if (layout.follow && !layout.scrolling && layout.more && layout.count > 0)
                state.scrollToItem(layout.count - 1)
        }
    }
    // Disclosure state for the screen's life: worked folds and activity groups, by key.
    val open = remember { mutableStateMapOf<String, Boolean>() }
    val haptics = LocalHapticFeedback.current
    // The list's row keys in order, recorded as its content is built, so a toggled row can be
    // found by index even after the rows around it change.
    val keys = remember { KeyOrder() }
    // A toggled disclosure keeps its place on screen: content opens and closes below it. The
    // list only pins its FIRST visible row by key; when a fold removes that row (reading inside
    // an open group, then closing it) it falls back to an index and the page jumps.
    var anchor by remember { mutableStateOf<Anchor?>(null) }
    val toggle: (String, Boolean) -> Unit = { key, value ->
        following = false
        haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
        val row = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key }
        if (row != null) anchor = Anchor(key, row.offset, (anchor?.serial ?: 0) + 1)
        open[key] = value
    }
    LaunchedEffect(anchor) {
        val target = anchor ?: return@LaunchedEffect
        // Wait for the layout that applies the toggle, then put the row back where it was.
        withFrameNanos { }
        val index = keys.indexOf(target.key)
        if (index < 0) return@LaunchedEffect
        val now = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == target.key }
        if (now != null) {
            if (now.offset != target.offset) state.scrollBy((now.offset - target.offset).toFloat())
        } else {
            state.scrollToItem(index)
            state.scrollBy(-target.offset.toFloat())
        }
    }
    val details = remember(loadDetail != null) { StepDetails(loadDetail) }
    // The turn whose tasks / files a sheet shows, by id, so running tasks keep updating inside it.
    var shownTasks by remember { mutableStateOf<String?>(null) }
    val openTasks: (String) -> Unit = { shownTasks = it }
    // The turn whose changed files the sheet shows.
    var shownFiles by remember { mutableStateOf<String?>(null) }
    val openFiles: (String) -> Unit = { shownFiles = it }
    shownFiles?.let { id ->
        val files = (entries.firstOrNull { it.id == id } as? ChatEntry.Assistant)?.files.orEmpty()
        if (files.isNotEmpty()) FilesSheet(id, files, loadDiff) { shownFiles = null }
    }
    shownTasks?.let { id ->
        val tasks = entries.firstOrNull { it.id == id }.let { it as? ChatEntry.Assistant }?.layout?.tasks.orEmpty()
        // Tasks that left the transcript just leave the sheet closed.
        if (tasks.isNotEmpty()) TasksSheet(tasks) { shownTasks = null }
    }
    LazyColumn(modifier, state = state, contentPadding = contentPadding) content@{
        keys.reset()
        with(KeyRecorder(this@content, keys)) { transcriptRows(entries, open, toggle, details, openTasks, openFiles, actions, relatedSessions, navigateSession, meId, decideProposal) }
        // A small stable end anchor avoids enormous scroll offsets and measuring the
        // whole final Markdown block merely to discover its bottom.
        item(key = "transcript-end", contentType = "end") { Spacer(Modifier.height(LodySpacing.xxs)) }
    }
}

private data class FollowLayout(
    val follow: Boolean, val scrolling: Boolean, val more: Boolean, val count: Int,
    val viewportEnd: Int, val tailIndex: Int?, val tailOffset: Int?, val tailSize: Int?,
)

/** A toggled row and its offset from the list's top before the toggle; [serial] re-runs equal toggles. */
private data class Anchor(val key: Any, val offset: Int, val serial: Int)

/** Row keys in list order; rebuilt whenever the list content is. */
private class KeyOrder {
    private val keys = ArrayList<Any>()
    private var index = HashMap<Any, Int>()
    fun reset() { keys.clear(); index = HashMap() }
    fun add(key: Any?) { if (key != null) { index[key] = keys.size }; keys += key ?: Unit }
    fun indexOf(key: Any): Int = index[key] ?: -1
}

/** Records each row's key on its way into the real scope. */
private class KeyRecorder(private val scope: LazyListScope, private val keys: KeyOrder) : LazyListScope by scope {
    override fun item(key: Any?, contentType: Any?, content: @Composable LazyItemScope.() -> Unit) {
        keys.add(key)
        scope.item(key, contentType, content)
    }

    override fun items(
        count: Int,
        key: ((index: Int) -> Any)?,
        contentType: (index: Int) -> Any?,
        itemContent: @Composable LazyItemScope.(index: Int) -> Unit,
    ) {
        repeat(count) { keys.add(key?.invoke(it)) }
        scope.items(count, key, contentType, itemContent)
    }
}

private fun LazyListScope.transcriptRows(
    entries: List<ChatEntry>,
    open: Map<String, Boolean>,
    toggle: (String, Boolean) -> Unit,
    details: StepDetails,
    onOpenTasks: (String) -> Unit,
    onOpenFiles: (String) -> Unit,
    actions: MessageActionState,
    relatedSessions: List<app.lody.android.runtime.CatalogSession>,
    navigateSession: (String) -> Unit,
    meId: String?,
    decideProposal: ProposalDecider?,
) {
        entries.forEach { entry ->
            when (entry) {
                is ChatEntry.Operations -> {
                    if (entry.events.isNotEmpty()) item(key = entry.id, contentType = "operations") { OperationCards(entry.events, relatedSessions, navigateSession) }
                    if (entry.proposals.isNotEmpty()) item(key = "${entry.id}#proposals", contentType = "proposals") {
                        ProposalCards(entry.proposals, meId, decideProposal, Modifier.animateItem().padding(bottom = LodySpacing.md))
                    }
                }
                is ChatEntry.User -> item(key = entry.id, contentType = "user") { UserTurn(entry, actions) }
                is ChatEntry.Assistant -> {
                    val layout = entry.layout
                    if (layout.folded) {
                        val key = "${entry.id}#worked"
                        val expanded = open[key] ?: false
                        item(key = key, contentType = "disclosure") {
                            Disclosure(
                                entry.worked.ifEmpty { stringResource(R.string.chat_finished_working) },
                                expanded,
                                // Clear of the user's message above, close to the reply below (iOS `durationLead`).
                                Modifier.animateItem().padding(top = LodySpacing.md),
                            ) { toggle(key, it) }
                        }
                        if (expanded) turnBlocks(entry, layout.folding, open, toggle, details)
                    }
                    turnBlocks(entry, layout.visible, open, toggle, details)
                    if (entry.working) {
                        val last = layout.blocks.lastOrNull()
                        val thinking = last is TurnLayout.Activity && last.items.lastOrNull() is TurnItem.Thought
                        item(key = "${entry.id}#live", contentType = "live") { LiveStatus(thinking, Modifier.animateItem()) }
                    }
                    turnOutput(entry, onOpenTasks, onOpenFiles)
                    turnFooter(entry, actions)
                    item(key = "${entry.id}#end", contentType = "turn-end") { Spacer(Modifier.height(LodySpacing.lg)) }
                }
            }
        }
}

/** Web's mobile conversation inset. */
val TranscriptMargin = LodySpacing.lg

/**
 * Web's mobile user turn: the delivery mark, time and sender name right-aligned above a large
 * rounded bubble, with the sender's avatar beside the bubble's top.
 */
@Composable
private fun UserTurn(entry: ChatEntry.User, actions: MessageActionState) {
    val colors = LodyTheme.colors
    var expanded by androidx.compose.runtime.saveable.rememberSaveable(entry.id) { mutableStateOf(false) }
    var overflowing by remember(entry.text) { mutableStateOf(false) }
    var menu by remember(entry.id) { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = LodySpacing.sm)
            .padding(top = LodySpacing.lg, bottom = LodySpacing.xl),
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm, Alignment.End),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f, fill = false).combinedClickable(onClick = {}, onLongClick = { menu = true }), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
            Row(
                Modifier.height(UserHeaderHeight).padding(end = LodySpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
            ) {
                DeliveryMark(entry.delivery)
                if (entry.who.time.isNotEmpty()) Text(entry.who.time, style = LodyTheme.typography.footnote, color = colors.textTertiary, maxLines = 1)
                Text(entry.who.name, style = LodyTheme.typography.footnote, color = colors.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            // Attachments sit above the bubble, trailing-aligned, one chip each (name + kind glyph).
            if (entry.attachments.isNotEmpty()) {
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(
                    Modifier.widthIn(max = LodyLayout.readableMaxWidth),
                    horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs, Alignment.End),
                    verticalArrangement = Arrangement.spacedBy(LodySpacing.xs),
                ) {
                    entry.attachments.forEach { AttachmentChip(it.name, it.image) }
                }
            }
            if (entry.text.isNotBlank()) Text(
                androidx.compose.ui.text.buildAnnotatedString {
                    append(entry.text)
                    entry.references.forEach { reference ->
                        if (reference.start >= 0 && reference.end <= length && reference.end > reference.start)
                            addStyle(androidx.compose.ui.text.SpanStyle(color = colors.textLink), reference.start, reference.end)
                    }
                },
                style = LodyTheme.typography.reading,
                color = colors.textPrimary,
                maxLines = if (expanded) Int.MAX_VALUE else 6,
                overflow = TextOverflow.Ellipsis,
                onTextLayout = { if (!expanded) overflowing = it.hasVisualOverflow },
                modifier = Modifier
                    .widthIn(max = LodyLayout.readableMaxWidth)
                    .background(colors.fillSecondary, RoundedCornerShape(UserBubbleRadius))
                    .padding(horizontal = LodySpacing.lg, vertical = LodySpacing.lg),
            )
            if (overflowing || expanded) app.lody.android.designsystem.LodyTextButton(onClick = { expanded = !expanded }) {
                Text(stringResource(if (expanded) R.string.message_show_less else R.string.message_show_more), color = colors.textSecondary)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.message_copy)) },
                    leadingIcon = { Icon(LodyIcons.Copy, contentDescription = null) },
                    enabled = entry.text.isNotBlank(),
                    onClick = { clipboard.setText(AnnotatedString(entry.text)); menu = false },
                )
                if (entry.id == actions.editable) DropdownMenuItem(
                    text = { Text(stringResource(R.string.message_edit)) },
                    leadingIcon = { Icon(LodyIcons.Edit, contentDescription = null) },
                    onClick = { menu = false; actions.edit(entry.id) },
                )
            }
        }
        // Beside the bubble's top: past the header line and the gap under it.
        Avatar(entry.who.image, entry.who.name, UserAvatarSize, Modifier.padding(top = UserHeaderHeight + LodySpacing.xs))
    }
}

/** One attachment as a compact capsule: image or file glyph and the name (middle-truncated). */
@Composable
internal fun AttachmentChip(name: String, image: Boolean, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    val colors = LodyTheme.colors
    Row(
        modifier
            .heightIn(min = LodySize.controlSm)
            .widthIn(max = AttachmentChipMaxWidth)
            .background(colors.fillSecondary, RoundedCornerShape(LodyRadius.md))
            .padding(start = LodySpacing.sm, end = if (trailing == null) LodySpacing.md else LodySpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs),
    ) {
        Icon(if (image) LodyIcons.Image else LodyIcons.File, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
        Text(name, style = LodyTheme.typography.footnote, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f, fill = false))
        trailing?.invoke()
    }
}

private val AttachmentChipMaxWidth = LodySize.controlLg * 5
private val UserHeaderHeight = LodySpacing.xl
private val UserAvatarSize = LodySize.avatarLg - LodySpacing.xs
private val UserBubbleRadius = LodySpacing.xl

/** Web's delivery mark: a check once the agent picked the turn up, an open circle before. */
@Composable
private fun DeliveryMark(delivery: Delivery) {
    val colors = LodyTheme.colors
    val size = LodyIconSize.sm
    val label = stringResource(
        when (delivery) {
            Delivery.Sending -> R.string.chat_delivery_sending
            Delivery.Sent -> R.string.chat_delivery_sent
            Delivery.Queued -> R.string.chat_delivery_queued
            Delivery.Seen -> R.string.chat_delivery_seen
            Delivery.Failed -> R.string.chat_delivery_failed
        },
    )
    val mark = Modifier.size(size).semantics { contentDescription = label }
    when (delivery) {
        Delivery.Sending -> app.lody.android.designsystem.LodyLoadingIndicator(mark.padding(LodySpacing.xxs), color = colors.iconTertiary)
        Delivery.Seen -> Icon(LodyIcons.StateDone, contentDescription = label, tint = colors.accentDefault, modifier = Modifier.size(size))
        Delivery.Failed -> Icon(LodyIcons.Alert, contentDescription = label, tint = colors.dangerDefault, modifier = Modifier.size(size))
        Delivery.Queued -> Icon(LodyIcons.StateWaiting, contentDescription = label, tint = colors.iconTertiary, modifier = Modifier.size(size))
        Delivery.Sent -> Box(mark.padding(LodySpacing.xxs).border(1.dp, colors.iconTertiary, CircleShape))
    }
}

/**
 * One top-level Markdown block on design-system tokens. `retainState` keeps the previous
 * render while the renderer re-parses a growing block, so streaming text never flashes
 * back to the loading state.
 */
@Composable
fun MarkdownBlock(text: String, modifier: Modifier = Modifier, secondary: Boolean = false) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val state = rememberMarkdownState(content = text, retainState = true)
    Markdown(
        markdownState = state,
        modifier = modifier.fillMaxWidth(),
        colors = markdownColor(
            // DSH thought prose: answer typography in secondary ink.
            text = if (secondary) colors.textSecondary else colors.textPrimary,
            codeBackground = colors.codeBg,
            inlineCodeBackground = colors.codeInlineBg,
            dividerColor = colors.borderSubtle,
            tableBackground = colors.fillTertiary,
        ),
        typography = markdownTypography(
            h1 = type.title,
            h2 = type.headline,
            h3 = type.bodyEmphasis,
            h4 = type.bodyEmphasis,
            h5 = type.subhead,
            h6 = type.subhead,
            text = type.reading,
            code = type.code,
            inlineCode = type.reading.copy(fontFamily = type.code.fontFamily),
            quote = type.reading.copy(color = colors.textSecondary, fontStyle = FontStyle.Italic),
            paragraph = type.reading,
            ordered = type.reading,
            bullet = type.reading,
            list = type.reading,
            textLink = TextLinkStyles(style = SpanStyle(color = colors.textLink)),
            table = type.bodySmall,
        ),
        components = markdownComponents(codeBlock = highlightedCodeBlock, codeFence = highlightedCodeFence),
    )
}
