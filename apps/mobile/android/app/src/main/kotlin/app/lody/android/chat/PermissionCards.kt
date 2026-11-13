package app.lody.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import app.lody.android.R
import app.lody.android.designsystem.LodyButton
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyLoadingIndicator
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyStroke
import app.lody.android.designsystem.LodyTheme
import app.lody.android.runtime.PermissionOption
import app.lody.android.runtime.QuestionMeta
import app.lody.android.runtime.RuntimeException
import app.lody.android.runtime.StepBlock
import app.lody.android.runtime.ToolPermission
import app.lody.android.runtime.TurnItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Answers a permission request (entry, step, request, option, and an ask-user-question's answers
 * by question key) through the runtime's `respondPermission` and returns its state (`accepted` /
 * `stale` / `conflict`); throws the runtime's failure. Null where there is no runtime or the
 * session cannot take an answer: requests then only wait.
 */
typealias PermissionResponder = suspend (entryId: String, itemId: String, requestId: String, optionId: String, answers: Map<String, Any>?) -> String

/** Content type of a row whose request waits on the reader; the transcript brings a new one into view. */
internal const val PendingPermissionRow = "permission-pending"

/**
 * A tool step's permission request, as the row after the step (plan approvals render with their
 * plan instead): while pending, a raised card with what would happen and the answer; once
 * answered, the record; once withdrawn, nothing.
 */
internal fun LazyListScope.stepPermission(
    entry: ChatEntry.Assistant,
    tool: TurnItem.Tool,
    key: String,
    details: StepDetails,
    respond: PermissionResponder?,
) {
    val permission = tool.permission ?: return
    item(key = "$key#permission", contentType = if (permission.pending) PendingPermissionRow else "permission") {
        Box(Modifier.animateItem().fillMaxWidth().padding(horizontal = TranscriptMargin).padding(top = LodySpacing.xs, bottom = LodySpacing.sm)) {
            if (permission.pending) {
                val colors = LodyTheme.colors
                val shape = RoundedCornerShape(LodyRadius.xl)
                Column(
                    Modifier.fillMaxWidth()
                        .background(colors.bgRaised, shape)
                        .border(LodyStroke.default, colors.borderSubtle, shape)
                        .padding(LodySpacing.md),
                    verticalArrangement = Arrangement.spacedBy(LodySpacing.md),
                ) {
                    if (!permission.question) PermissionSubject(entry.id, tool, permission, details)
                    PermissionDecision(entry.id, tool, details, respond)
                }
            } else {
                PermissionDecision(entry.id, tool, details, respond)
            }
        }
    }
}

/**
 * Desktop `resolvePermissionSubject`, from what Android has: the command line and its directory
 * (the step's `terminal_command` detail), else the path. The title is the step row just above, so
 * it is not repeated; the summary carries no provider heading or reason, so none is invented.
 */
@Composable
private fun PermissionSubject(entryId: String, tool: TurnItem.Tool, permission: ToolPermission, details: StepDetails) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val detailKey = "${tool.id}:permission-subject:${permission.requestId}"
    val detail = details.cache[detailKey]
    if (tool.hasDetail && details.available) {
        LaunchedEffect(detailKey) {
            if (detail != null) return@LaunchedEffect
            try { details.cache[detailKey] = details.fetch(entryId, tool.id) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { }
        }
    }
    val command = detail?.blocks?.firstNotNullOfOrNull { it as? StepBlock.Command }
    val lines = when {
        command != null -> listOfNotNull("$ ${command.command}", command.cwd)
        tool.path != null -> listOf(tool.path)
        else -> return
    }
    androidx.compose.foundation.text.selection.SelectionContainer {
        Column(
            Modifier.fillMaxWidth().background(colors.fillTertiary, RoundedCornerShape(LodyRadius.md)).padding(LodySpacing.sm),
            verticalArrangement = Arrangement.spacedBy(LodySpacing.xxs),
        ) {
            lines.forEachIndexed { index, line ->
                Text(line, style = type.code, color = if (index == 0) colors.textPrimary else colors.textSecondary)
            }
        }
    }
}

/**
 * A request's answer (web `PermissionRequestBlock`, with desktop's answer prompt in place). While
 * pending: the provider's options as buttons in its order and words, the suggested one filled
 * (desktop `resolveSuggestedOptionId`); an ask-user-question gets its form instead, submitted with
 * the first allow option, plus a reject option as Decline. Where it cannot be answered here it
 * reads "Waiting for your answer". Once answered: the chosen option's name on one line, or a
 * question's answers; once withdrawn, nothing.
 */
@Composable
internal fun PermissionDecision(entryId: String, tool: TurnItem.Tool, details: StepDetails, respond: PermissionResponder?) {
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
        val submit: (PermissionOption, Map<String, Any>?) -> Unit = { option, answers ->
            if (busy == null && respond != null) {
                busy = option.optionId
                failure = null
                haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                scope.launch {
                    try {
                        when (respond(entryId, tool.id, permission.requestId, option.optionId, answers)) {
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
        val waiting: @Composable () -> Unit = {
            Text(stringResource(R.string.chat_permission_waiting), style = type.footnote, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (respond == null) { waiting(); return }
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
            if (permission.question) {
                val meta = permission.questions
                val allow = options.firstOrNull { it.allows }
                val decline = options.firstOrNull { it.tone == "reject" } ?: options.firstOrNull { it.tone == "rejectAlways" }
                // Malformed questions or no option to submit them with: never guess an answer.
                if (meta == null || allow == null) {
                    Text(stringResource(R.string.chat_permission_error_options), style = type.footnote, color = colors.dangerDefault)
                } else {
                    QuestionForm(permission.requestId, meta, busy, submitting = busy == allow.optionId) { submit(allow, it) }
                }
                decline?.let { OptionButton(it, primary = false, pending = busy == it.optionId, enabled = busy == null) { submit(it, null) } }
            } else if (options.isEmpty()) {
                waiting()
            } else {
                val suggested = permission.suggested
                for (option in options) {
                    OptionButton(option, primary = option == suggested, pending = busy == option.optionId, enabled = busy == null) { submit(option, null) }
                }
            }
            failure?.let { Text(permissionFailure(it), style = type.footnote, color = colors.dangerDefault) }
        }
        return
    }
    // Settled: the summary carries the decision; only a question's answers (possibly secret)
    // are read from the step's detail.
    if (permission.withdrawn) return
    val meta = permission.questions
    if (meta != null) {
        val detailKey = "${tool.id}:permission:${permission.requestId}"
        val detail = details.cache[detailKey]
        if (details.available) {
            LaunchedEffect(detailKey) {
                if (detail != null) return@LaunchedEffect
                try { details.cache[detailKey] = details.fetch(entryId, tool.id) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { }
            }
        }
        if (detail != null && detail.answers.isNotEmpty()) {
            QuestionAnswers(meta, detail.answers)
            return
        }
    }
    val chosen = permission.chosenOptionId ?: answered ?: return
    val option = options.firstOrNull { it.optionId == chosen }
    // An unknown option id (stale history) reads as allowed (web `resolvePermissionRecord`).
    val label = option?.name ?: stringResource(R.string.chat_permission_approved)
    Text(label, style = type.footnote, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** One provider option: the suggested one filled, the others quiet; a spinner while it is sent. */
@Composable
private fun OptionButton(option: PermissionOption, primary: Boolean, pending: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val colors = LodyTheme.colors
    LodyButton(
        onClick = onClick, enabled = enabled, shape = CircleShape, modifier = Modifier.fillMaxWidth(),
        colors = if (primary) ButtonDefaults.buttonColors(containerColor = colors.bgInverse, contentColor = colors.textInverse)
        else ButtonDefaults.buttonColors(containerColor = colors.fillTertiary, contentColor = colors.textPrimary),
        elevation = null,
    ) {
        // The invisible label keeps the button's size under the spinner.
        Box(contentAlignment = Alignment.Center) {
            Text(option.name, Modifier.alpha(if (pending) 0f else 1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (pending) LodyLoadingIndicator(Modifier.size(LodyIconSize.sm), color = if (primary) colors.textInverse else colors.textPrimary)
        }
    }
}

/** One question's draft: chosen labels, or typed text (iOS `PermissionQuestionView.Draft`). */
private data class Draft(val labels: List<String> = emptyList(), val text: String = "") {
    val answered: Boolean get() = text.isNotBlank() || labels.isNotEmpty()
}

/**
 * iOS `PermissionQuestionView` inline: every question with its header, choices (one, or several
 * when it is multi-select) with their descriptions and previews, and a text answer where the
 * question allows one (masked when secret). Typing replaces the choices and choosing clears the
 * text, as the runtime takes one or the other. Submit sends every answer by its question key.
 */
@Composable
private fun QuestionForm(requestId: String, meta: QuestionMeta, busy: String?, submitting: Boolean, onSubmit: (Map<String, Any>) -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val drafts = remember(requestId) { mutableStateListOf<Draft>().apply { repeat(meta.questions.size) { add(Draft()) } } }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(LodySpacing.lg)) {
        meta.questions.forEachIndexed { index, question ->
            val draft = drafts[index]
            Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
                if (question.header.isNotBlank()) Text(question.header, style = type.caption, color = colors.textSecondary)
                Text(question.question, style = type.subhead, color = colors.textPrimary)
                Text(
                    stringResource(
                        when {
                            question.options.isEmpty() -> R.string.chat_question_free_text
                            question.multiSelect -> R.string.chat_question_multiple
                            else -> R.string.chat_question_single
                        },
                    ),
                    style = type.footnote, color = colors.textTertiary,
                )
                for (option in question.options) {
                    val selected = option.label in draft.labels
                    val choose = {
                        drafts[index] = Draft(
                            labels = if (!question.multiSelect) listOf(option.label)
                            else if (selected) draft.labels - option.label else draft.labels + option.label,
                        )
                    }
                    Row(
                        Modifier.fillMaxWidth().clickable(enabled = busy == null, role = if (question.multiSelect) Role.Checkbox else Role.RadioButton, onClick = choose),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs),
                    ) {
                        if (question.multiSelect) Checkbox(selected, onCheckedChange = null, enabled = busy == null)
                        else RadioButton(selected, onClick = null, enabled = busy == null)
                        Column(Modifier.weight(1f).padding(top = LodySpacing.xs), verticalArrangement = Arrangement.spacedBy(LodySpacing.xxs)) {
                            Text(option.label, style = type.callout, color = colors.textPrimary)
                            option.description?.takeIf { it.isNotBlank() }?.let { Text(it, style = type.footnote, color = colors.textSecondary) }
                            option.preview?.takeIf { it.isNotBlank() }?.let { Text(it, style = type.code, color = colors.textSecondary) }
                        }
                    }
                }
                if (meta.allowsText(index)) {
                    OutlinedTextField(
                        draft.text, { drafts[index] = Draft(text = it) },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = busy == null,
                        placeholder = { Text(stringResource(if (question.options.isEmpty()) R.string.chat_question_custom else R.string.chat_question_other)) },
                        singleLine = question.isSecret,
                        visualTransformation = if (question.isSecret) PasswordVisualTransformation() else VisualTransformation.None,
                    )
                }
            }
        }
        val ready = drafts.all { it.answered }
        OptionButton(
            PermissionOption("submit", stringResource(R.string.chat_question_submit), "allow_once"),
            primary = true, pending = submitting, enabled = busy == null && ready,
        ) {
            onSubmit(drafts.mapIndexed { index, draft ->
                val value: Any = when {
                    draft.text.isNotBlank() -> draft.text.trim()
                    meta.questions[index].multiSelect -> draft.labels
                    else -> draft.labels.first()
                }
                meta.key(index) to value
            }.toMap())
        }
    }
}

/** An answered question's answers, read only; a secret answer stays masked. */
@Composable
private fun QuestionAnswers(meta: QuestionMeta, answers: Map<String, List<String>>) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
        meta.questions.forEachIndexed { index, question ->
            val values = answers[meta.key(index)] ?: return@forEachIndexed
            Text(question.header.ifBlank { question.question }, style = type.caption, color = colors.textTertiary)
            Text(if (question.isSecret) "••••••••" else values.joinToString(", "), style = type.footnote, color = colors.textSecondary)
        }
    }
}

@Composable
private fun permissionFailure(code: String): String = stringResource(
    when (code) {
        "stale" -> R.string.chat_permission_error_stale
        "conflict" -> R.string.chat_permission_error_answered
        "invalid_option" -> R.string.chat_permission_error_option
        "invalid_answers" -> R.string.chat_permission_error_answers
        else -> R.string.chat_permission_error_send
    },
)
