// The Schedules tab (web `schedule-list.tsx` on mobile): Scheduled tasks and Scheduled messages
// sections; rows are name, frequency · agent · computer, and the status in words.
package app.lody.android.schedules

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.runtime.LaunchedEffect
import app.lody.android.designsystem.LodyRadius
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import app.lody.android.R
import app.lody.android.designsystem.LodyButton
import app.lody.android.designsystem.LodyIconButton
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyLayout
import app.lody.android.designsystem.LodyLoadingIndicator
import app.lody.android.designsystem.LodySize
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTextButton
import app.lody.android.designsystem.LodyTheme
import app.lody.android.runtime.RuntimeScope
import app.lody.android.runtime.ScheduleItem
import app.lody.android.runtime.ScheduleList
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** The tab's list for one account / workspace; Home refreshes it on show, pull, workspace change and after each command. */
@Stable
class SchedulesState(private val service: ScheduleService, val scope: RuntimeScope) {
    var list by mutableStateOf<ScheduleList?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var pulling by mutableStateOf(false)
        private set
    /** The last read's failure code; a held list stays visible. */
    var failure by mutableStateOf<String?>(null)
        private set

    suspend fun refresh(pull: Boolean = false) {
        if (loading) return
        loading = true; pulling = pull
        try {
            list = service.list(scope)
            failure = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: ScheduleFailure) { failure = error.code }
        catch (_: Exception) { failure = "runtime_failed" }
        finally { loading = false; pulling = false }
    }

    suspend fun detail(scheduleId: String) = service.detail(scope, scheduleId)

    /** One write; any failure comes back as a [ScheduleFailure]. Refreshes afterwards either way. */
    suspend fun command(request: app.lody.android.runtime.ScheduleCommandRequest): String = try {
        service.command(scope, request)
    } finally { refresh() }
}

@Composable
fun rememberSchedulesState(service: ScheduleService?, scope: RuntimeScope?): SchedulesState? =
    remember(service, scope) { if (service != null && scope != null) SchedulesState(service, scope) else null }

/**
 * The list under the Home header. [query] filters by title. Row actions follow web: Pause /
 * Resume for a timed task (owner), Run for a manual one, Delete (always confirmed), and the last
 * run's chat.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SchedulesList(
    state: SchedulesState?,
    query: String,
    padding: PaddingValues,
    onOpen: (ScheduleItem) -> Unit,
    onNew: () -> Unit,
    onOpenSession: (String) -> Unit,
    onNotice: (String) -> Unit,
) {
    val colors = LodyTheme.colors
    val scope = rememberCoroutineScope()
    if (state == null) {
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
            LodyLoadingIndicator(Modifier.size(LodySize.controlMd), color = colors.iconSecondary)
        }
        return
    }
    val list = state.list
    val failure = state.failure
    var selectedGroup by remember(state) { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<ScheduleItem?>(null) }
    val runStarted = stringResource(R.string.schedules_run_started)
    val untitled = stringResource(R.string.schedules_untitled)
    val failures = FailureTexts.current()
    val run: (ScheduleItem, String) -> Unit = { item, action ->
        scope.launch {
            try {
                state.command(ScheduleForms.request(action, item.scheduleId, null, null))
                if (action == "run") onNotice(runStarted.format(item.title.ifBlank { untitled }))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: ScheduleFailure) { onNotice(failures(error.code)) }
        }
    }
    PullToRefreshBox(
        isRefreshing = state.pulling,
        onRefresh = { scope.launch { state.refresh(pull = true) } },
        modifier = Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()),
    ) {
        val bottom = PaddingValues(bottom = padding.calculateBottomPadding())
        when {
            list == null && failure != null && !state.loading -> Message(
                stringResource(R.string.schedules_load_error), bottom,
                action = stringResource(R.string.schedules_retry), onAction = { scope.launch { state.refresh() } },
            )
            list == null -> Box(Modifier.fillMaxSize().padding(bottom), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
                    LodyLoadingIndicator(Modifier.size(LodySize.controlMd), color = colors.iconSecondary)
                    Text(stringResource(R.string.schedules_loading), style = LodyTheme.typography.body, color = colors.textSecondary)
                }
            }
            list.items.isEmpty() -> Message(
                stringResource(R.string.schedules_empty), bottom, help = stringResource(R.string.schedules_empty_help),
                icon = LodyIcons.Clock, action = stringResource(R.string.schedules_new), onAction = onNew,
            )
            else -> {
                val needle = query.trim()
                val searched = list.items.filter { needle.isEmpty() || it.title.contains(needle, ignoreCase = true) }
                val counts = searched.groupingBy { it.state.group }.eachCount()
                val activeGroup = selectedGroup?.takeIf { (counts[it] ?: 0) > 0 }
                LaunchedEffect(activeGroup) { selectedGroup = activeGroup }
                val shown = searched.filter { activeGroup == null || it.state.group == activeGroup }
                    .sortedBy { scheduleGroupOrder.indexOf(it.state.group) }
                val taskRows = shown.filterNot { it.scheduledMessage }
                val messageRows = shown.filter { it.scheduledMessage }
                if (shown.isEmpty()) Message(stringResource(R.string.schedules_search_empty, needle), bottom)
                else LazyColumn(Modifier.fillMaxSize(), contentPadding = bottom) {
                    item(key = "overview") {
                        ScheduleOverview(counts, activeGroup) { selectedGroup = it.takeUnless { it == activeGroup } }
                    }
                    if (failure != null) item(key = "failure") {
                        Text(
                            failures(failure),
                            style = LodyTheme.typography.footnote, color = colors.textSecondary,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.xs),
                        )
                    }
                    if (taskRows.isNotEmpty()) {
                        item(key = "tasks") { SectionHeader(stringResource(R.string.schedules_section_tasks), taskRows.size) }
                        items(taskRows, key = { it.scheduleId }) { item ->
                            ScheduleRow(item, onOpen = { onOpen(item) }, onAction = { run(item, it) }, onDelete = { deleting = item }, onOpenSession = onOpenSession)
                        }
                    }
                    if (messageRows.isNotEmpty()) {
                        item(key = "messages") { SectionHeader(stringResource(R.string.schedules_section_messages), messageRows.size) }
                        items(messageRows, key = { it.scheduleId }) { item ->
                            ScheduleRow(item, onOpen = { onOpen(item) }, onAction = { run(item, it) }, onDelete = { deleting = item }, onOpenSession = onOpenSession)
                        }
                    }
                }
            }
        }
    }
    deleting?.let { item ->
        DeleteDialog(item, onDismiss = { deleting = null }) { deleting = null; run(item, "delete") }
    }
}

/** Failure copy resolved in composition, for use from callbacks. */
internal object FailureTexts {
    @Composable
    fun current(): (String) -> String {
        val codes = listOf(
            "schedule_not_found", "schedule_not_owner", "schedule_machine_unsupported", "schedule_prompt_invalid",
            "schedule_trigger_invalid", "schedule_title_invalid", "schedule_message_read_only", "schedule_deleted",
            "schedule_conflict", "schedule_invalid", "schedule_write_unknown", "metadata_not_ready", "workspace_changed",
            "unsupported_command",
        ).associateWith { failureText(it) }
        val generic = failureText("")
        return { code -> codes[code] ?: generic }
    }
}

/** The owner actions a row offers; [ScheduleItem.machineSupported] gates resume and run. */
internal fun rowActions(item: ScheduleItem): List<String> {
    if (!item.isOwner) return emptyList()
    if (item.scheduledMessage) return listOf("delete")
    val manual = item.rule.kind == "manual"
    return buildList {
        when {
            manual -> if (item.machineSupported) add("run")
            item.state.group == "ended" -> Unit
            item.enabled -> add("pause")
            item.machineSupported -> add("resume")
        }
        add("delete")
    }
}

@Composable
private fun SectionHeader(title: String, count: Int) {
    val colors = LodyTheme.colors
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) { heading() }
            .padding(start = LodyLayout.screenPaddingX, end = LodyLayout.screenPaddingX, top = LodySpacing.lg, bottom = LodySpacing.xs),
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
    ) {
        Text(title, style = LodyTheme.typography.subhead, color = colors.textTertiary)
        Text(count.toString(), style = LodyTheme.typography.subhead.copy(fontFeatureSettings = "tnum"), color = colors.textTertiary)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ScheduleRow(
    item: ScheduleItem,
    onOpen: () -> Unit,
    onAction: (String) -> Unit,
    onDelete: () -> Unit,
    onOpenSession: (String) -> Unit,
) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    var menu by remember { mutableStateOf(false) }
    val ended = item.state.group == "ended"
    val attention = item.state.group == "attention"
    val status = statusText(item.state)
    val separator = stringResource(R.string.schedules_detail_separator)
    val summary = listOfNotNull(item.agentName, item.machineName ?: item.machineId, item.projectName).filter { it.isNotBlank() }.joinToString(separator)
    val actions = rowActions(item)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.xxs)
            .clip(RoundedCornerShape(LodyRadius.lg)).background(colors.bgRaised).heightIn(min = LodySize.listRow)
            .combinedClickable(onClick = onOpen, onLongClick = { menu = true })
            .padding(start = LodyLayout.screenPaddingX, top = LodySpacing.sm, bottom = LodySpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
    ) {
        ScheduleMark(item)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(LodySpacing.xxs)) {
            Row(horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm), verticalAlignment = Alignment.Top) {
                Text(
                    item.title.ifBlank { stringResource(R.string.schedules_untitled) }, style = type.headline,
                    color = if (ended) colors.textTertiary else colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(status.label, style = type.footnote, color = if (attention) colors.warningDefault else colors.textSecondary,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = LodyLayout.trailingMetaMaxWidth))
            }
            Text(ruleSummary(item.rule), style = type.footnote, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(summary, style = type.caption, color = colors.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if ((attention || item.state.kind == "blocked") && !status.detail.isNullOrBlank()) {
                Text(status.detail, style = type.caption, color = colors.warningDefault, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Box {
            val more = stringResource(R.string.schedules_more)
            LodyIconButton(onClick = { menu = true }, modifier = Modifier.semantics { contentDescription = more }) {
                Glyph(LodyIcons.More, colors.iconSecondary)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = colors.bgOverlay) {
                for (action in actions.filter { it != "delete" }) {
                    val (label, icon) = when (action) {
                        "run" -> R.string.schedules_run to LodyIcons.Play
                        "pause" -> R.string.schedules_pause to LodyIcons.Pause
                        else -> R.string.schedules_resume to LodyIcons.Undo
                    }
                    MenuItem(stringResource(label), icon) { menu = false; onAction(action) }
                }
                item.lastSessionId?.let { session ->
                    MenuItem(stringResource(R.string.schedules_open_last_chat), LodyIcons.Session) { menu = false; onOpenSession(session) }
                }
                if ("delete" in actions) MenuItem(stringResource(R.string.schedules_delete), LodyIcons.Trash, colors.dangerDefault) { menu = false; onDelete() }
            }
        }
    }
}

@Composable
internal fun MenuItem(label: String, icon: ImageVector, tint: Color = LodyTheme.colors.textPrimary, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, style = LodyTheme.typography.body, color = tint) },
        leadingIcon = { Glyph(icon, if (tint == LodyTheme.colors.textPrimary) LodyTheme.colors.iconSecondary else tint, LodyIconSize.sm) },
        onClick = onClick,
    )
}

/** Delete always confirms; a scheduled message says its sent text stays. */
@Composable
internal fun DeleteDialog(item: ScheduleItem, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val colors = LodyTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.bgOverlay,
        title = { Text(stringResource(R.string.schedules_delete_title, item.title.ifBlank { stringResource(R.string.schedules_untitled) }), style = LodyTheme.typography.headline, color = colors.textPrimary) },
        text = {
            Text(
                stringResource(if (item.scheduledMessage) R.string.schedules_delete_message_help else R.string.schedules_delete_help),
                style = LodyTheme.typography.body, color = colors.textSecondary,
            )
        },
        confirmButton = { LodyTextButton(onClick = onConfirm) { Text(stringResource(R.string.schedules_delete), color = colors.dangerDefault) } },
        dismissButton = { LodyTextButton(onClick = onDismiss) { Text(stringResource(R.string.schedules_cancel), color = colors.textPrimary) } },
    )
}

@Composable
private fun Message(text: String, padding: PaddingValues, help: String? = null, icon: ImageVector? = null, action: String? = null, onAction: () -> Unit = {}) {
    val colors = LodyTheme.colors
    Box(Modifier.fillMaxSize().padding(padding).padding(horizontal = LodyLayout.screenPaddingX), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = LodyLayout.readableMaxWidth), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
            if (icon != null) Glyph(icon, colors.iconTertiary, LodyIconSize.xl)
            Text(text, style = LodyTheme.typography.headline, color = colors.textPrimary, textAlign = TextAlign.Center)
            if (help != null) Text(help, style = LodyTheme.typography.body, color = colors.textSecondary, textAlign = TextAlign.Center)
            if (action != null) {
                Spacer(Modifier.height(LodySpacing.sm))
                LodyButton(onClick = onAction) { Text(action) }
            }
        }
    }
}

@Composable
internal fun Glyph(icon: ImageVector, tint: Color, size: Dp = LodyIconSize.md, modifier: Modifier = Modifier) {
    Icon(icon, contentDescription = null, modifier = modifier.size(size), tint = tint)
}
