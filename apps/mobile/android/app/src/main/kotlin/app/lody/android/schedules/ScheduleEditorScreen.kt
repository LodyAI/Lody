// A schedule's page: stored status and quick actions, then Task, When and Run with cards. New schedules and owners' own schedules are editable; others are read only.
package app.lody.android.schedules

import android.widget.NumberPicker
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.ui.semantics.heading
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.viewinterop.AndroidView
import app.lody.android.R
import app.lody.android.create.CreationService
import app.lody.android.designsystem.LodyIconButton
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyLayout
import app.lody.android.designsystem.LodyLoadingIndicator
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySize
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTextButton
import app.lody.android.designsystem.LodyTheme
import app.lody.android.runtime.CatalogSnapshot
import app.lody.android.runtime.CreationOptions
import app.lody.android.runtime.ScheduleCommandRequest
import app.lody.android.runtime.ScheduleDetail
import app.lody.android.runtime.ScheduleItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneOffset

/**
 * [scheduleId] null starts a new schedule. The live row (enabled, status) comes from the
 * refreshed list; editing the draft never changes the stored status card.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleEditorScreen(
    state: SchedulesState,
    scheduleId: String?,
    snapshot: CatalogSnapshot?,
    creation: CreationService?,
    onClose: () -> Unit,
    onNotice: (String) -> Unit,
    onOpenSession: (String) -> Unit,
) {
    BackHandler(onBack = onClose)
    val colors = LodyTheme.colors
    val scope = rememberCoroutineScope()
    val failures = FailureTexts.current()
    // A new schedule's id is chosen once, so retrying its creation reuses it.
    val id = rememberSaveable { scheduleId ?: ScheduleForms.newId() }
    val creating = scheduleId == null
    val item = state.list?.items?.firstOrNull { it.scheduleId == id }
    var detail by remember { mutableStateOf<ScheduleDetail?>(null) }
    var loadFailure by remember { mutableStateOf<String?>(null) }
    var options by remember { mutableStateOf<CreationOptions?>(null) }
    var form by remember { mutableStateOf<ScheduleForm?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // The last write whose outcome is unknown: retrying the same change reuses its request id.
    var unknown by remember { mutableStateOf<ScheduleCommandRequest?>(null) }
    var deleting by remember { mutableStateOf(false) }
    val zoneId = state.list?.timeZone(form?.machineId) ?: java.time.ZoneId.systemDefault().id
    val zone = zoneOf(zoneId)

    LaunchedEffect(creation, state.scope) {
        if (creation == null) return@LaunchedEffect
        options = try { creation.cachedOptions(state.scope, null) } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
        try { options = creation.options(state.scope, null) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { }
    }
    LaunchedEffect(id) {
        if (creating) return@LaunchedEffect
        try {
            val loaded = state.detail(id)
            detail = loaded
            if (form == null) form = ScheduleForms.of(loaded, System.currentTimeMillis(), zone)
            loadFailure = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: ScheduleFailure) { loadFailure = failure.code }
        catch (_: Exception) { loadFailure = "runtime_failed" }
    }
    // A new schedule starts on the first computer and agent offered.
    LaunchedEffect(options, creating) {
        if (!creating || form != null) return@LaunchedEffect
        val agent = options?.agents?.firstOrNull() ?: if (options == null && creation != null) return@LaunchedEffect else null
        form = ScheduleForms.blank(agent?.machineId, agent?.id, System.currentTimeMillis(), zone)
    }

    val current: ScheduleItem? = item ?: detail?.item
    val editable = ScheduleForms.editable(current)
    val supported = current?.machineSupported != false
    val owner = current?.isOwner != false
    val draft = form?.let { ScheduleForms.draft(it, zoneId, snapshot) }
    val untitled = stringResource(R.string.schedules_untitled)
    val runStarted = stringResource(R.string.schedules_run_started)

    fun write(action: String, draft: app.lody.android.runtime.ScheduleDraft? = null, done: () -> Unit = {}) {
        if (busy) return
        val request = ScheduleForms.request(action, id, draft, unknown)
        busy = true; error = null
        scope.launch {
            try {
                state.command(request)
                unknown = null
                done()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: ScheduleFailure) {
                unknown = request.takeIf { failure.code == ScheduleCodes.WRITE_UNKNOWN }
                error = failures(failure.code)
            } finally { busy = false }
        }
    }

    Scaffold(
        containerColor = colors.bgGrouped,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        if (creating) stringResource(R.string.schedules_new) else (current?.title ?: form?.title).orEmpty().ifBlank { untitled },
                        style = LodyTheme.typography.headline, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    val back = stringResource(R.string.chat_back)
                    LodyIconButton(onClick = onClose, modifier = Modifier.semantics { contentDescription = back }) { Glyph(LodyIcons.Back, colors.iconPrimary) }
                },
                actions = {
                    if (editable) LodyTextButton(
                        onClick = { draft?.let { write(if (creating) "create" else "edit", it) { onClose() } } },
                        enabled = draft != null && supported && !busy,
                    ) { Text(stringResource(if (busy) R.string.schedules_saving else R.string.schedules_save)) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.bgGrouped, scrolledContainerColor = colors.bgGrouped),
            )
        },
    ) { padding ->
        val value = form
        when {
            value == null && loadFailure != null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(failures(loadFailure.orEmpty()), style = LodyTheme.typography.body, color = colors.textSecondary, modifier = Modifier.padding(horizontal = LodyLayout.screenPaddingX))
            }
            value == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                LodyLoadingIndicator(Modifier.size(LodySize.controlMd), color = colors.iconSecondary)
            }
            else -> Column(
                Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState())
                    .padding(horizontal = LodyLayout.screenPaddingX).navigationBarsPadding(),
                verticalArrangement = Arrangement.spacedBy(LodySpacing.xxl),
            ) {
                val fields = editable && !busy
                val edit = { next: ScheduleForm -> form = next; error = null }
                when {
                    current?.scheduledMessage == true -> Note(stringResource(R.string.schedules_message_read_only))
                    current != null && !current.isOwner -> Note(stringResource(R.string.schedules_read_only))
                    current?.destination == ScheduleForm.EXISTING_SESSION -> Note(stringResource(R.string.schedules_existing_read_only))
                }
                if (current != null) ScheduleHero(current, busy,
                    onCommand = { action -> write(action) { if (action == "run") onNotice(runStarted.format(current.title.ifBlank { untitled })) } },
                    onOpenSession = onOpenSession,
                )
                EditorSection(stringResource(R.string.schedules_section_task)) {
                    Group {
                        Field(stringResource(R.string.schedules_name), value.title, stringResource(R.string.schedules_name_placeholder), fields, singleLine = true) { edit(value.copy(title = it)) }
                        Divider()
                        Field(stringResource(R.string.schedules_prompt), value.prompt, stringResource(R.string.schedules_prompt_placeholder), fields, singleLine = false) { edit(value.copy(prompt = it)) }
                    }
                }
                if (current?.scheduledMessage != true) {
                    EditorSection(stringResource(R.string.schedules_section_when)) { Timing(value, zone, zoneId, fields, edit) }
                    EditorSection(stringResource(R.string.schedules_section_run_with)) {
                        Target(value, current, options, snapshot, state.list?.ownedMachineIds, fields, edit)
                        Destination(value, fields, edit)
                    }
                }
                if (!supported) Note(stringResource(R.string.schedules_upgrade))
                if (editable && options != null && options?.agents.isNullOrEmpty() && creating) Note(stringResource(R.string.schedules_no_agents))
                error?.let { Text(it, style = LodyTheme.typography.footnote, color = colors.dangerDefault) }
                if (current != null && owner) Group {
                    LodyTextButton(onClick = { deleting = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.schedules_delete), color = colors.dangerDefault)
                    }
                }
                Spacer(Modifier.height(LodySpacing.xxl))
            }
        }
    }
    if (deleting && current != null) DeleteDialog(current, onDismiss = { deleting = false }) {
        deleting = false
        write("delete") { onClose() }
    }
}

@Composable
private fun EditorSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
        Text(title, style = LodyTheme.typography.footnote, color = LodyTheme.colors.textTertiary, modifier = Modifier.semantics { heading() })
        content()
    }
}

/** Computer, Agent, Model, Mode and Project; choices come from the live creation options. */
@Composable
private fun Target(form: ScheduleForm, item: ScheduleItem?, options: CreationOptions?, snapshot: CatalogSnapshot?, owned: Set<String>?, enabled: Boolean, edit: (ScheduleForm) -> Unit) {
    val agents = options?.agents.orEmpty()
    val machineName = { machineId: String -> snapshot?.machineNames?.get(machineId) ?: item?.takeIf { it.machineId == machineId }?.machineName ?: machineId }
    // A schedule runs only on its owner's computer; a stored computer that went away stays listed.
    val machines = (agents.map { it.machineId }.filter { owned?.contains(it) != false } + listOfNotNull(form.machineId)).distinct()
    val machineAgents = agents.filter { it.machineId == form.machineId }
    val agent = machineAgents.firstOrNull { it.id == form.agentConfigId }
    val agentLabel = agent?.name ?: item?.takeIf { it.agentConfigId == form.agentConfigId }?.agentName ?: form.agentConfigId
    val capability = options?.capability(agent)
    val choose = stringResource(R.string.schedules_choose)
    val default = stringResource(R.string.schedules_default)
    Group {
        Choice(stringResource(R.string.schedules_computer), form.machineId?.let(machineName) ?: choose, machines.map { it to machineName(it) }, enabled) { machine ->
            if (machine == form.machineId) return@Choice
            val first = agents.firstOrNull { it.machineId == machine }
            // A local project belongs to its computer; GitHub repositories run anywhere.
            val keepProject = form.projectId?.let { ScheduleForms.projects(snapshot, machine).any { p -> p.id == it } } == true
            edit(form.copy(machineId = machine, agentConfigId = first?.id, modelId = null, modeId = null, projectId = form.projectId.takeIf { keepProject }))
        }
        Divider()
        Choice(stringResource(R.string.schedules_agent), agentLabel ?: choose, machineAgents.map { it.id to it.name }, enabled) {
            if (it != form.agentConfigId) edit(form.copy(agentConfigId = it, modelId = null, modeId = null))
        }
        val models = capability?.models.orEmpty()
        if (models.isNotEmpty() || form.modelId != null) {
            Divider()
            Choice(
                stringResource(R.string.schedules_model), models.firstOrNull { it.id == form.modelId }?.name ?: form.modelId ?: default,
                listOf<Pair<String?, String>>(null to default) + models.map { it.id to it.name }, enabled,
            ) { edit(form.copy(modelId = it)) }
        }
        val modes = capability?.modes.orEmpty()
        if (modes.isNotEmpty() || form.modeId != null) {
            Divider()
            Choice(
                stringResource(R.string.schedules_mode), modes.firstOrNull { it.id == form.modeId }?.name ?: form.modeId ?: default,
                listOf<Pair<String?, String>>(null to default) + modes.map { it.id to it.name }, enabled,
            ) { edit(form.copy(modeId = it)) }
        }
        Divider()
        val projects = ScheduleForms.projects(snapshot, form.machineId)
        val none = stringResource(R.string.schedules_project_none)
        val projectName = form.projectId?.let { id -> projects.firstOrNull { it.id == id }?.name ?: item?.projectName ?: id.substringAfterLast(':') } ?: none
        Choice(stringResource(R.string.schedules_project), projectName, listOf<Pair<String?, String>>(null to none) + projects.map { it.id to it.name }, enabled) {
            if (it != form.projectId) edit(form.copy(projectId = it, branch = if (it?.startsWith(ScheduleForm.GITHUB_PREFIX) == true) form.branch.ifBlank { DEFAULT_BRANCH } else "", useWorktree = null))
        }
        if (form.isGithub) {
            Divider()
            InlineField(stringResource(R.string.schedules_branch), form.branch, enabled) { edit(form.copy(branch = it)) }
        }
    }
}

private const val DEFAULT_BRANCH = "main"

@Composable
private fun Destination(form: ScheduleForm, enabled: Boolean, edit: (ScheduleForm) -> Unit) {
    val label = stringResource(R.string.schedules_send_to)
    Group {
        if (form.destination == ScheduleForm.EXISTING_SESSION) Choice(label, stringResource(R.string.schedules_destination_existing), emptyList<Pair<String, String>>(), false) {}
        else Choice(
            label, stringResource(if (form.destination == ScheduleForm.OWN_SESSION) R.string.schedules_destination_own else R.string.schedules_destination_new),
            listOf(ScheduleForm.NEW_SESSION to stringResource(R.string.schedules_destination_new), ScheduleForm.OWN_SESSION to stringResource(R.string.schedules_destination_own)),
            enabled,
        ) { edit(form.copy(destination = it)) }
    }
}

/** Frequency and its time; wall-clock rules are authored in the computer's zone. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun Timing(form: ScheduleForm, zone: java.time.ZoneId, zoneId: String, enabled: Boolean, edit: (ScheduleForm) -> Unit) {
    val colors = LodyTheme.colors
    var picking by remember { mutableStateOf<String?>(null) }
    Group {
        if (form.frequency == Frequency.Unsupported) {
            Column(Modifier.fillMaxWidth().padding(vertical = LodySpacing.md), verticalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
                Text(form.original?.let { ruleSummary(it) }.orEmpty(), style = LodyTheme.typography.body, color = colors.textPrimary)
                Text(stringResource(R.string.schedules_repeat_unsupported_hint), style = LodyTheme.typography.footnote, color = colors.textSecondary)
                if (enabled) LodyTextButton(onClick = { edit(form.editRule { copy(frequency = Frequency.Daily) }) }) { Text(stringResource(R.string.schedules_repeat_replace)) }
            }
            return@Group
        }
        Choice(stringResource(R.string.schedules_repeat), frequencyLabel(form.frequency), Frequency.choices.map { it to frequencyLabel(it) }, enabled) {
            if (it != form.frequency) edit(form.editRule { copy(frequency = it) })
        }
        when (form.frequency) {
            Frequency.Weekly -> {
                Divider()
                Toggles(stringResource(R.string.schedules_on_days), WeekOrder.map { it to weekdayName(it) }, form.weekdays, enabled) { day ->
                    edit(form.editRule { copy(weekdays = if (day in weekdays) weekdays - day else weekdays + day) })
                }
            }
            Frequency.Monthly -> {
                Divider()
                Toggles(stringResource(R.string.schedules_month_days), (1..31).map { it to it.toString() }, form.days, enabled) { day ->
                    edit(form.editRule { copy(days = if (day in days) days - day else days + day) })
                }
            }
            Frequency.Hours -> {
                Divider()
                Action(stringResource(R.string.schedules_every), everyHours(form.everyHours), enabled) { picking = "every" }
            }
            Frequency.Minutes -> {
                Divider()
                Action(stringResource(R.string.schedules_every), everyMinutes(form.everyMinutes), enabled) { picking = "every" }
            }
            Frequency.Once -> {
                val at = form.onceAt
                Divider()
                Action(stringResource(R.string.schedules_date), at?.let { dateText(it, zone) }.orEmpty(), enabled) { picking = "date" }
                Divider()
                Action(stringResource(R.string.schedules_at), at?.let { ScheduleForms.local(it, zone) }?.let { timeOfDay(it.hour, it.minute) }.orEmpty(), enabled) { picking = "onceTime" }
            }
            else -> Unit
        }
        if (form.frequency in setOf(Frequency.Daily, Frequency.Weekdays, Frequency.Weekly, Frequency.Monthly)) {
            Divider()
            Action(stringResource(R.string.schedules_at), timeOfDay(form.hour, form.minute), enabled) { picking = "time" }
        }
    }
    if (form.frequency != Frequency.Manual) {
        Text(stringResource(R.string.schedules_time_zone, zoneId), style = LodyTheme.typography.footnote, color = colors.textTertiary)
    }
    val context = LocalContext.current
    when (picking) {
        "every" -> {
            val hours = form.frequency == Frequency.Hours
            val range = if (hours) ScheduleForm.EVERY_HOURS else ScheduleForm.EVERY_MINUTES
            val labels = range.map { if (hours) everyHours(it) else everyMinutes(it) }
            var chosen by remember { mutableStateOf((if (hours) form.everyHours else form.everyMinutes).coerceIn(range)) }
            AlertDialog(
                onDismissRequest = { picking = null },
                containerColor = colors.bgOverlay,
                title = { Text(stringResource(R.string.schedules_every)) },
                text = {
                    // A wheel over the whole range; a step that does not divide the clock runs as an anchored interval.
                    AndroidView(
                        modifier = Modifier.fillMaxWidth(),
                        factory = { context ->
                            NumberPicker(context).apply {
                                minValue = range.first
                                maxValue = range.last
                                displayedValues = labels.toTypedArray()
                                wrapSelectorWheel = false
                                descendantFocusability = NumberPicker.FOCUS_BLOCK_DESCENDANTS
                                value = chosen
                                setOnValueChangedListener { _, _, next -> chosen = next }
                            }
                        },
                    )
                },
                confirmButton = {
                    LodyTextButton(onClick = {
                        picking = null
                        edit(form.editRule { if (hours) copy(everyHours = chosen) else copy(everyMinutes = chosen) })
                    }) { Text(stringResource(android.R.string.ok)) }
                },
                dismissButton = { LodyTextButton(onClick = { picking = null }) { Text(stringResource(R.string.schedules_cancel)) } },
            )
        }
        "time", "onceTime" -> {
            val local = form.onceAt?.let { ScheduleForms.local(it, zone) }
            val once = picking == "onceTime"
            val time = rememberTimePickerState(
                initialHour = if (once) local?.hour ?: 9 else form.hour,
                initialMinute = if (once) local?.minute ?: 0 else form.minute,
                is24Hour = android.text.format.DateFormat.is24HourFormat(context),
            )
            AlertDialog(
                onDismissRequest = { picking = null },
                containerColor = colors.bgOverlay,
                text = { TimePicker(time) },
                confirmButton = {
                    LodyTextButton(onClick = {
                        picking = null
                        if (once && local != null) edit(form.editRule { copy(onceAt = local.withHour(time.hour).withMinute(time.minute).toInstant().toEpochMilli()) })
                        else if (!once) edit(form.editRule { copy(hour = time.hour, minute = time.minute) })
                    }) { Text(stringResource(android.R.string.ok)) }
                },
                dismissButton = { LodyTextButton(onClick = { picking = null }) { Text(stringResource(R.string.schedules_cancel)) } },
            )
        }
        "date" -> {
            val local = form.onceAt?.let { ScheduleForms.local(it, zone) }
            // The picker works in UTC midnights; the chosen day keeps the wall time in the computer's zone.
            val date = rememberDatePickerState(initialSelectedDateMillis = local?.toLocalDate()?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli())
            DatePickerDialog(
                onDismissRequest = { picking = null },
                confirmButton = {
                    LodyTextButton(onClick = {
                        picking = null
                        val chosen = date.selectedDateMillis?.let { Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }
                        if (chosen != null && local != null) edit(form.editRule { copy(onceAt = local.with(chosen).toInstant().toEpochMilli()) })
                    }) { Text(stringResource(android.R.string.ok)) }
                },
                dismissButton = { LodyTextButton(onClick = { picking = null }) { Text(stringResource(R.string.schedules_cancel)) } },
            ) { DatePicker(date) }
        }
    }
}

// MARK: - Rows

/** A card of rows on the sunken surface. */
@Composable
private fun Group(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(LodyRadius.lg)).background(LodyTheme.colors.bgRaised).padding(horizontal = LodySpacing.md),
    ) { content() }
}

@Composable
private fun Divider() = HorizontalDivider(color = LodyTheme.colors.borderSubtle)

/** Label leading, the value trailing; tapping opens the choices in a menu at the value. */
@Composable
private fun <T> Choice(label: String, value: String, options: List<Pair<T, String>>, enabled: Boolean, onSelect: (T) -> Unit) {
    val colors = LodyTheme.colors
    var open by remember { mutableStateOf(false) }
    val active = enabled && options.isNotEmpty()
    Row(
        Modifier.fillMaxWidth().heightIn(min = LodySize.controlLg)
            .let { if (active) it.clickable(role = Role.DropdownList) { open = true } else it },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
    ) {
        Text(label, style = LodyTheme.typography.body, color = colors.textPrimary)
        Spacer(Modifier.weight(1f))
        Box {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
                Text(value, style = LodyTheme.typography.body, color = if (enabled) colors.textSecondary else colors.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = LodyLayout.readableMaxWidth / 3))
                if (active) Glyph(LodyIcons.Expand, colors.iconTertiary, LodyIconSize.sm)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = colors.bgOverlay) {
                options.forEach { (option, name) ->
                    DropdownMenuItem(
                        text = { Text(name, style = LodyTheme.typography.body, color = colors.textPrimary) },
                        trailingIcon = { if (name == value) Glyph(LodyIcons.Check, colors.accentFg, LodyIconSize.sm) },
                        onClick = { open = false; onSelect(option) },
                    )
                }
            }
        }
    }
}

@Composable
private fun Action(label: String, value: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = LodyTheme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = LodySize.controlLg).let { if (enabled) it.clickable(role = Role.Button, onClick = onClick) else it },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = LodyTheme.typography.body, color = colors.textPrimary, modifier = Modifier.weight(1f))
        Text(value, style = LodyTheme.typography.body, color = if (enabled) colors.textSecondary else colors.textTertiary)
    }
}

/** Adaptive day grid with separate, non-overlapping 48 dp touch targets. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun <T> Toggles(label: String, options: List<Pair<T, String>>, selected: Set<T>, enabled: Boolean, onToggle: (T) -> Unit) {
    val colors = LodyTheme.colors
    Column(Modifier.fillMaxWidth().padding(vertical = LodySpacing.md), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
        Text(label, style = LodyTheme.typography.body, color = colors.textPrimary)
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val columns = ((maxWidth + LodySpacing.xs) / (LodySize.controlLg + LodySpacing.xs)).toInt().coerceIn(1, 7)
            Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
                options.chunked(columns).forEach { week ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
                        week.forEach { (option, name) ->
                            val on = option in selected
                            Box(
                                Modifier.weight(1f).heightIn(min = LodySize.controlLg)
                                    .toggleable(value = on, enabled = enabled, role = Role.Checkbox) { onToggle(option) },
                                contentAlignment = Alignment.Center,
                            ) {
                                Box(Modifier.size(LodySize.controlSm).clip(CircleShape).background(if (on) colors.accentSolid else colors.fillSecondary), contentAlignment = Alignment.Center) {
                                    Text(name, style = LodyTheme.typography.footnote, color = if (on) colors.textOnAccent else colors.textPrimary, maxLines = 1)
                                }
                            }
                        }
                        repeat(columns - week.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
                }
        }
    }
}

/** A labelled text field on the sunken surface; the prompt grows with its text. */
@Composable
private fun Field(label: String, value: String, placeholder: String, enabled: Boolean, singleLine: Boolean, onChange: (String) -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    Column(Modifier.padding(vertical = LodySpacing.md), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
        Text(label, style = type.footnote, color = colors.textTertiary)
        BasicTextField(
            value = value, onValueChange = onChange, enabled = enabled, singleLine = singleLine,
            minLines = if (singleLine) 1 else 4,
            textStyle = type.body.copy(color = if (enabled) colors.textPrimary else colors.textSecondary),
            cursorBrush = SolidColor(colors.accentDefault),
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
            decorationBox = { inner ->
                Box(
                    Modifier.fillMaxWidth(),
                ) {
                    if (value.isEmpty()) Text(placeholder, style = type.body, color = colors.textPlaceholder)
                    inner()
                }
            },
        )
    }
}

@Composable
private fun InlineField(label: String, value: String, enabled: Boolean, onChange: (String) -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    Row(Modifier.fillMaxWidth().heightIn(min = LodySize.controlLg), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
        Text(label, style = type.body, color = colors.textPrimary)
        BasicTextField(
            value = value, onValueChange = onChange, enabled = enabled, singleLine = true,
            textStyle = type.body.copy(color = colors.textSecondary, textAlign = androidx.compose.ui.text.style.TextAlign.End),
            cursorBrush = SolidColor(colors.accentDefault),
            modifier = Modifier.weight(1f).semantics { contentDescription = label },
        )
    }
}

@Composable
private fun Note(text: String) {
    Text(text, style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary, modifier = Modifier.fillMaxWidth())
}
