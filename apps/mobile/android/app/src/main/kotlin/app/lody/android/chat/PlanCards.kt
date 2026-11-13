package app.lody.android.chat

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import app.lody.android.R
import app.lody.android.designsystem.LodyButton
import app.lody.android.designsystem.LodyIconButton
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyLoadingIndicator
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyStroke
import app.lody.android.designsystem.LodyTheme
import app.lody.android.runtime.PermissionOption
import app.lody.android.runtime.RuntimeException
import app.lody.android.runtime.TurnItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Answers a plan approval (entry, step, request, option) through the runtime's `respondPermission`
 * and returns its state (`accepted` / `stale` / `conflict`); throws the runtime's failure. Null
 * where there is no runtime or the session cannot take an answer: the approval then only waits.
 */
typealias PermissionResponder = suspend (entryId: String, itemId: String, requestId: String, optionId: String) -> String

/** A history plan clamps to this height; the header opens it in full. */
private val PlanClampHeight = 240.dp

/**
 * A `proposed_plan` row (Codex): web `ProposedPlanBlock`, the plan panel on its own. It opens in
 * full while the turn's plan approval waits or the plan is still being written.
 */
internal fun LazyListScope.proposedPlan(
    entry: ChatEntry.Assistant,
    plan: TurnItem.ProposedPlan,
    key: String,
    open: Map<String, Boolean>,
    toggle: (String, Boolean) -> Unit,
) {
    item(key = key, contentType = "plan") {
        PlanCard(
            plan.markdown, entry.prose[plan.id], key, open, toggle,
            defaultOpen = entry.layout.planAwaiting || (plan.streaming && entry.working),
            modifier = Modifier.animateItem(),
        )
    }
}

/**
 * A plan-approval (`switch_mode`) step: web `PlanExitBlock`. The plan it carries (Claude, Kimi)
 * shows in the plan card unless the turn shows it as its own `proposed_plan` row (Codex); the
 * decision follows: the provider's options while it waits, the chosen option once answered,
 * nothing once withdrawn.
 */
internal fun LazyListScope.planExit(
    entry: ChatEntry.Assistant,
    tool: TurnItem.Tool,
    key: String,
    open: Map<String, Boolean>,
    toggle: (String, Boolean) -> Unit,
    details: StepDetails,
    respond: PermissionResponder?,
) {
    val carried = tool.plan?.takeUnless { entry.layout.separatePlan }
    val permission = tool.permission
    item(key = key, contentType = if (carried != null) "plan" else "plan-decision") {
        val decision: (@Composable () -> Unit)? = if (permission != null) ({ PlanDecision(entry.id, tool, details, respond) }) else null
        if (carried != null) {
            PlanCard(
                carried, entry.prose[tool.id], key, open, toggle,
                defaultOpen = permission?.pending == true,
                modifier = Modifier.animateItem(),
                footer = decision,
            )
        } else if (decision != null) {
            Box(Modifier.animateItem().fillMaxWidth().padding(horizontal = TranscriptMargin).padding(bottom = LodySpacing.md)) { decision() }
        }
    }
}

/**
 * Web `PlanPanel`: a raised card headed "Proposed Plan" with a copy action, the plan as Markdown.
 * A plan that is history clamps, and the header opens it; [defaultOpen] (an unanswered approval,
 * a plan still being written) shows it in full. A reader's own toggle is kept by [stateKey].
 */
@Composable
private fun PlanCard(
    markdown: String,
    blocks: MarkdownBlocks?,
    stateKey: String,
    open: Map<String, Boolean>,
    toggle: (String, Boolean) -> Unit,
    defaultOpen: Boolean,
    modifier: Modifier = Modifier,
    footer: (@Composable () -> Unit)? = null,
) {
    val colors = LodyTheme.colors
    val shape = RoundedCornerShape(LodyRadius.xl)
    // Opened while the reader decided: it does not collapse under them once answered (web).
    var held by remember(stateKey) { mutableStateOf(false) }
    SideEffect { if (defaultOpen) held = true }
    val expanded = open[stateKey] ?: (defaultOpen || held)
    var overflows by remember(stateKey) { mutableStateOf(false) }
    val togglable = overflows || expanded
    val state = stringResource(if (expanded) R.string.home_tree_expanded else R.string.home_tree_collapsed)
    val angle by animateFloatAsState(if (expanded) 0f else -90f, label = "plan-chevron")
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = TranscriptMargin)
            .padding(bottom = LodySpacing.md)
            .background(colors.bgRaised, shape)
            .border(LodyStroke.default, colors.borderSubtle, shape)
            .animateContentSize(),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .then(
                    if (togglable) Modifier
                        .clickable(role = Role.Button) { toggle(stateKey, !expanded) }
                        .semantics { stateDescription = state }
                    else Modifier,
                )
                .padding(start = LodySpacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
        ) {
            if (togglable) Icon(LodyIcons.Expand, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.xs).rotate(angle))
            else Icon(LodyIcons.PermissionPlan, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.xs))
            Text(
                stringResource(R.string.chat_plan_title), style = LodyTheme.typography.subhead, color = colors.textPrimary,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            PlanCopyButton(markdown)
        }
        Box(Modifier.fillMaxWidth().height(LodyStroke.default).background(colors.borderSubtle))
        Box {
            ClampedBody(expanded, onOverflow = { overflows = it }) {
                Column(Modifier.fillMaxWidth().padding(horizontal = LodySpacing.md).padding(top = LodySpacing.md)) {
                    val parts = blocks?.blocks ?: listOf(markdown)
                    parts.forEachIndexed { index, text ->
                        key(index) { MarkdownBlock(text, Modifier.padding(bottom = LodySpacing.md)) }
                    }
                }
            }
            // A clamped plan fades into the card so it reads as continuing.
            if (!expanded && overflows) {
                Box(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .height(LodySpacing.xxxl)
                        .background(Brush.verticalGradient(listOf(Color.Transparent, colors.bgRaised))),
                )
            }
        }
        footer?.let {
            Box(Modifier.fillMaxWidth().height(LodyStroke.default).background(colors.borderSubtle))
            Box(Modifier.fillMaxWidth().padding(LodySpacing.md)) { it() }
        }
    }
}

/** Measures its content in full; shows it all when [open], else at most [PlanClampHeight]. */
@Composable
private fun ClampedBody(open: Boolean, onOverflow: (Boolean) -> Unit, content: @Composable () -> Unit) {
    val limit = with(LocalDensity.current) { PlanClampHeight.roundToPx() }
    Layout(content, Modifier.clipToBounds()) { measurables, constraints ->
        val placeable = measurables.first().measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
        onOverflow(placeable.height > limit)
        val height = if (open) placeable.height else minOf(placeable.height, limit)
        layout(placeable.width, height) { placeable.place(0, 0) }
    }
}

@Composable
private fun PlanCopyButton(markdown: String) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(markdown) { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1600); copied = false } }
    LodyIconButton(onClick = { clipboard.setText(AnnotatedString(markdown)); copied = true }) {
        Icon(
            if (copied) LodyIcons.Check else LodyIcons.Copy,
            contentDescription = stringResource(if (copied) R.string.message_copied else R.string.chat_plan_copy),
            tint = LodyTheme.colors.iconSecondary,
            modifier = Modifier.size(LodyIconSize.sm),
        )
    }
}

/**
 * The approval's decision (web `PermissionRequestBlock`, with desktop's answer prompt in place):
 * while pending, the provider's options as buttons — allow kinds filled, reject kinds quiet, in
 * the provider's order and words — or "Waiting for your answer" where it cannot be answered here;
 * once answered, the chosen option's name on one line; once withdrawn, nothing.
 */
@Composable
private fun PlanDecision(entryId: String, tool: TurnItem.Tool, details: StepDetails, respond: PermissionResponder?) {
    val permission = tool.permission ?: return
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var busy by remember(permission.requestId) { mutableStateOf<String?>(null) }
    var failure by remember(permission.requestId) { mutableStateOf<String?>(null) }
    // The option this device answered with, shown until the transcript records it.
    var answered by rememberSaveable(permission.requestId) { mutableStateOf<String?>(null) }
    val options = permission.options
    if (permission.pending && answered == null) {
        if (respond == null || options.isEmpty()) {
            Text(stringResource(R.string.chat_permission_waiting), style = type.footnote, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            return
        }
        val submit: (PermissionOption) -> Unit = { option ->
            if (busy == null) {
                busy = option.optionId
                failure = null
                haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                scope.launch {
                    try {
                        when (respond(entryId, tool.id, permission.requestId, option.optionId)) {
                            "accepted" -> answered = option.optionId
                            "conflict" -> failure = "conflict"
                            else -> failure = "stale"
                        }
                    } catch (error: CancellationException) { throw error }
                    catch (error: RuntimeException) { failure = error.fault.code }
                    catch (_: Exception) { failure = "failed" }
                    finally { busy = null }
                }
            }
        }
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
            for (option in options) {
                val pending = busy == option.optionId
                val label: @Composable () -> Unit = {
                    // Spinner replaces the label while pending; the invisible label keeps the size.
                    Box(contentAlignment = Alignment.Center) {
                        Text(option.name, Modifier.alpha(if (pending) 0f else 1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (pending) LodyLoadingIndicator(Modifier.size(LodyIconSize.sm), color = if (option.allows) colors.textInverse else colors.textPrimary)
                    }
                }
                LodyButton(
                    onClick = { submit(option) }, enabled = busy == null, shape = CircleShape,
                    modifier = Modifier.fillMaxWidth(),
                    colors = if (option.allows) ButtonDefaults.buttonColors(containerColor = colors.bgInverse, contentColor = colors.textInverse)
                    else ButtonDefaults.buttonColors(containerColor = colors.fillTertiary, contentColor = colors.textPrimary),
                    elevation = null,
                ) { label() }
            }
            failure?.let { Text(permissionFailure(it), style = type.footnote, color = colors.dangerDefault) }
        }
        return
    }
    // Settled: the summary says only that it was answered, so the outcome is read from the step's detail.
    val detailKey = "${tool.id}:permission:${permission.requestId}"
    val detail = details.cache[detailKey]
    if (details.available) {
        LaunchedEffect(detailKey, permission.pending) {
            if (permission.pending || detail != null) return@LaunchedEffect
            try { details.cache[detailKey] = details.fetch(entryId, tool.id) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { }
        }
    }
    if (detail?.withdrawn == true) return
    val chosen = detail?.chosenOption ?: answered ?: return
    val option = options.firstOrNull { it.optionId == chosen }
    // An unknown option id (stale history) reads as allowed (web `resolvePermissionRecord`).
    val label = option?.name ?: stringResource(if (option == null || option.allows) R.string.chat_permission_approved else R.string.chat_permission_denied)
    Text(label, style = type.footnote, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

@Composable
private fun permissionFailure(code: String): String = stringResource(
    when (code) {
        "stale" -> R.string.chat_permission_error_stale
        "conflict" -> R.string.chat_permission_error_answered
        "invalid_option" -> R.string.chat_permission_error_option
        else -> R.string.chat_permission_error_send
    },
)
