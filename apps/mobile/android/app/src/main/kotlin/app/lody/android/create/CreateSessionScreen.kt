// New session using the existing scoped cloud runtime.
//
// Follows web's mobile new-chat page (`mobile-new-chat-sheet.tsx`, `mobile-inline-picker.tsx`,
// `mobile-run-config-sheet.tsx`), checked by driving its Storybook stories: computer and project
// are full-width cards whose options expand in place right below them (one open at a time, the
// project list searchable); then the worktree chip for local projects or the branch line for
// GitHub projects; then the composer (+, the run-config chip, send; no @, as web and iOS). The
// assistant lives in the run-config chip's sheet, not on the page. Styled like iOS: no fills on
// lines or lists, lists aligned with their line, computers with OS icons.
//
// Text creation and dispatch use the same workspace lease as the catalog.

package app.lody.android.create

import app.lody.android.designsystem.LodyFilledIconButton

import androidx.compose.foundation.selection.toggleable

import app.lody.android.designsystem.LodyIconButton as IconButton
import app.lody.android.designsystem.LodyTextButton as TextButton

import app.lody.android.chat.PendingAttachment
import app.lody.android.chat.SessionAttachmentUploads
import app.lody.android.chat.AttachmentChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import app.lody.android.designsystem.shadow
import app.lody.android.home.AgentMark
import app.lody.android.runtime.AgentRole

import app.lody.android.designsystem.LodyElevations

import androidx.compose.ui.draw.dropShadow

import androidx.compose.ui.text.withStyle

import androidx.compose.ui.text.buildAnnotatedString

import androidx.compose.ui.text.SpanStyle

import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures

import androidx.compose.animation.animateContentSize

import app.lody.android.runtime.*
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material3.OutlinedTextField
import androidx.activity.compose.BackHandler
import kotlinx.coroutines.CancellationException
import java.util.UUID

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.lody.android.R
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyLayout
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySize
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTheme
import app.lody.android.runtime.CatalogProject
import app.lody.android.runtime.CatalogSnapshot
import kotlinx.coroutines.launch
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.first
import androidx.compose.runtime.snapshotFlow

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateSessionScreen(snapshot: CatalogSnapshot?, repository: CreationService, runtimeScope: RuntimeScope, onSubmit: (CreateRequest) -> Unit, onBack: () -> Unit) {
    val dismissKeyboard = rememberKeyboardDismissal()
    val colors = LodyTheme.colors
    // Multi-repository projects (web Project groups), read once; listed as projects pinned to
    // their local members' computer or to none. One that cannot run (two computers) is left out.
    var groups by remember(runtimeScope) { mutableStateOf<List<ProjectGroup>>(emptyList()) }
    LaunchedEffect(runtimeScope) {
        groups = try { repository.projectGroups(runtimeScope) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { emptyList() }
    }
    val runnable = groups.filter { !it.conflict && it.members.size > 1 }
    val groupProjects = runnable.map { group ->
        CatalogProject(
            CreateSessionModel.GROUP_PREFIX + group.id, group.machineId.orEmpty(), group.name,
            androidx.compose.ui.res.pluralStringResource(R.plurals.create_group_members, group.members.size, group.members.size),
        )
    }
    val base = snapshot ?: CatalogSnapshot(0, emptyList(), emptyList(), emptyList())
    val catalog = base.copy(projects = base.projects.filterNot { CreateSessionModel.isGroup(it.id) } + groupProjects)
    var target by remember(catalog.revision == 0L) { mutableStateOf(CreateSessionModel.initial(catalog)) }
    var prompt by rememberSaveable { mutableStateOf("") }
    // The field with its caret and IME composition; the @ panel reads the trigger at the caret.
    var field by remember { mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(prompt, androidx.compose.ui.text.TextRange(prompt.length))) }
    LaunchedEffect(prompt) {
        if (field.text != prompt) field = androidx.compose.ui.text.input.TextFieldValue(prompt, androidx.compose.ui.text.TextRange(prompt.length))
    }
    var composerFocused by remember { mutableStateOf(false) }
    // @ references: the catalogs, the panel's levels, and Role labels to resolve at send.
    val mentions = app.lody.android.chat.rememberMentionState(runtimeScope)
    var runConfig by remember { mutableStateOf(false) }
    var openContext by remember { mutableStateOf<String?>(null) }
    var searchFocused by remember { mutableStateOf(false) }
    val coverComposer = searchFocused && WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    val application = context.applicationContext as app.lody.android.LodyApplication
    var attachments by remember(runtimeScope) { mutableStateOf<List<PendingAttachment>>(emptyList()) }
    val uploadFailed = stringResource(R.string.chat_attach_failed)
    val attachLimit = stringResource(R.string.chat_attach_limit)
    var attachMenu by remember { mutableStateOf(false) }
    val addAttachments: (List<android.net.Uri>, Boolean) -> Unit = { uris, image ->
        scope.launch {
            val picked = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                uris.mapNotNull { uri ->
                    try { SessionAttachmentUploads.describe(context.contentResolver, uri, image) }
                    catch (_: Exception) { null }
                }
            }
            val oversized = picked.filter(SessionAttachmentUploads::oversized)
            val merged = attachments + (picked - oversized.toSet())
            val kept = merged.filter { it.image }.take(8) + merged.filter { !it.image }.take(8)
            attachments = merged.filter { it in kept }
            if (oversized.isNotEmpty()) snackbar.showSnackbar(context.getString(R.string.chat_attach_too_large, SessionAttachmentUploads.FILE_LIMIT_MB, oversized.first().name))
            else if (kept.size < merged.size) snackbar.showSnackbar(attachLimit)
            else if (picked.size < uris.size) snackbar.showSnackbar(uploadFailed)
        }
    }
    val photoPicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(8),
    ) { addAttachments(it, true) }
    val filePicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments(),
    ) { addAttachments(it, false) }
    var options by remember(runtimeScope) { mutableStateOf<CreationOptions?>(null) }
    var targetChosen by remember(runtimeScope) { mutableStateOf(false) }
    var onlineMachines by remember(runtimeScope) { mutableStateOf<Set<String>?>(null) }
    var optionsFresh by remember(runtimeScope) { mutableStateOf(false) }
    var agentId by rememberSaveable { mutableStateOf<String?>(null) }
    var modelId by rememberSaveable { mutableStateOf<String?>(null) }
    var modeId by rememberSaveable { mutableStateOf<String?>(null) }
    var effort by rememberSaveable { mutableStateOf<String?>(null) }
    // Agent Roles (web chat landing): listed once per runtime; the picked Role names the
    // composer only while it is still what will run (`CreateSessionModel.roleApplied`).
    var roles by remember(runtimeScope) { mutableStateOf<List<AgentRole>?>(null) }
    var roleId by rememberSaveable { mutableStateOf<String?>(null) }
    // Device-local: the last selection per computer and recently used configurations.
    var runPrefs by remember(runtimeScope) { mutableStateOf<RunConfigPrefs?>(null) }
    LaunchedEffect(runtimeScope) {
        runPrefs = try { repository.runConfigs(runtimeScope) ?: RunConfigPrefs() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { RunConfigPrefs() }
    }
    LaunchedEffect(runtimeScope) {
        roles = try { repository.roles(runtimeScope) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { null }
    }
    val branchRepo = target.projectId.orEmpty().removePrefix("github:")
    var branches by remember(runtimeScope, target.projectId, target.chat) { mutableStateOf(BranchState()) }
    var branchLoading by remember(runtimeScope, target.projectId, target.chat) { mutableStateOf(false) }
    var branchFailed by remember(runtimeScope, target.projectId, target.chat) { mutableStateOf(false) }
    var branchPage by remember(runtimeScope, target.projectId, target.chat) { mutableStateOf(1) }
    var branchAttempt by remember(runtimeScope, target.projectId, target.chat) { mutableStateOf(0) }
    val branch = branches.selected
    val sessionId = rememberSaveable { UUID.randomUUID().toString() }
    val turnId = rememberSaveable { UUID.randomUUID().toString() }
    var attempted by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val agents = options?.agents.orEmpty().filter { it.machineId == target.machineId }
    val agent = agents.firstOrNull { it.id == agentId } ?: agents.firstOrNull()
    val capability = options?.capability(agent)
    val roleItems = CreateSessionModel.roleItems(roles.orEmpty(), target.machineId, agents)
    val activeRole = roleItems.firstOrNull { it.role.id == roleId }
        ?.takeIf { CreateSessionModel.roleApplied(it, agent?.id, modelId, modeId, effort) }
    LaunchedEffect(runtimeScope, agent?.id, optionsFresh, capability != null) {
        val selected = agent ?: return@LaunchedEffect
        if (optionsFresh) {
            try { repository.refreshCapability(runtimeScope, selected.id) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Cached choices remain usable for display. */ }
        }
    }
    val github = CreateSessionModel.isGithub(target.projectId) && !target.chat
    val canSend = optionsFresh && agent != null && !attempted && !busy && (!github || branch.isNotBlank())
    val waitingText = stringResource(R.string.create_agent)
    LaunchedEffect(runtimeScope, target.machineId) {
        // A Role binds one machine's agent exactly, so another computer clears it (web).
        agentId = null; modelId = null; modeId = null; effort = null; roleId = null
        // Then the computer's last selection, once its agents are listed, unless one was picked meanwhile.
        val machine = target.machineId ?: return@LaunchedEffect
        val (prefs, loaded) = snapshotFlow { runPrefs to options }
            .first { (prefs, loaded) -> prefs != null && loaded?.agents?.any { it.machineId == machine } == true }
        if (agentId != null) return@LaunchedEffect
        val saved = prefs?.machines?.get(machine) ?: return@LaunchedEffect
        val chosen = loaded?.agents?.firstOrNull { it.machineId == machine && it.id == saved.agentId } ?: return@LaunchedEffect
        val applied = CreateSessionModel.applicable(saved, loaded?.capability(chosen))
        agentId = applied.agentId; modelId = applied.modelId; modeId = applied.modeId; effort = applied.effort
    }
    LaunchedEffect(runtimeScope) {
        optionsFresh = false
        options = null; agentId = null; modelId = null; modeId = null; effort = null
        try { options = repository.cachedOptions(runtimeScope, null) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* A missing/corrupt cache is a normal cold start. */ }
        options?.let { target = CreateSessionModel.withInitialAvailability(target, it, explicitlySelected = targetChosen) }
        // Refresh on runtime/catalog/presence changes, never on a timer.
        try {
            repository.observeOptions(runtimeScope).collect { loaded ->
                onlineMachines = loaded?.onlineMachineIds
                optionsFresh = loaded != null && loaded.availability == "online"
                if (loaded != null) {
                    options = loaded
                    target = CreateSessionModel.withInitialAvailability(target, loaded, explicitlySelected = targetChosen)
                }
            }
        }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { optionsFresh = false; onlineMachines = null }
    }
    LaunchedEffect(runtimeScope, target.projectId, target.chat, branchPage, branchAttempt) {
        if (!github) return@LaunchedEffect
        branchLoading = true
        branchFailed = false
        if (branchPage == 1 && branches.page == null) {
            try { branches = branches.restore(repository.cachedBranches(runtimeScope, branchRepo)) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { }
        }
        try {
            val loaded = repository.branches(runtimeScope, branchRepo, branchPage)
            branches = branches.accept(loaded, branchPage)
            try { repository.cacheBranches(runtimeScope, branchRepo, branches.page!!) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { branchFailed = true }
        finally { branchLoading = false }
    }
    BackHandler(enabled = busy) { }
    val send = {
        val chosen = agent
        if (canSend && !attempted && !busy && (prompt.isNotBlank() || attachments.isNotEmpty())) {
            attempted = true; busy = true
            val request = CreateRequest(
                // Role labels ("🧪 Reviewer") go out as their tokens (`@role:<id>`).
                sessionId, turnId, target.projectId.takeUnless { target.chat }, chosen.machineId, chosen.id, mentions.resolve(prompt), branch.takeIf { github }, target.worktree, modelId, modeId, effort,
                agentRoleId = activeRole?.role?.id,
                configOptionValues = activeRole?.let { CreateSessionModel.roleChoice(it.target).options }.orEmpty(),
            )
            dismissKeyboard()
            val picked = attachments
            // Recorded when a chat is started, never when a value changes (web).
            val started = CreateSessionModel.started(
                runPrefs ?: RunConfigPrefs(), chosen.machineId, RunSelection(chosen.id, modelId, modeId, effort),
                activeRole?.role?.id, System.currentTimeMillis(),
            )
            runPrefs = started
            // Outlives the page, which closes as the chat opens.
            scope.launch(NonCancellable) {
                try { repository.saveRunConfigs(runtimeScope, started) }
                catch (_: Exception) { /* A failed write only loses the default. */ }
            }
            scope.launch {
                val blocks = try {
                    if (picked.isEmpty()) emptyList() else application.attachments.upload(runtimeScope, sessionId, picked)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) {
                    attempted = false; busy = false
                    snackbar.showSnackbar(uploadFailed)
                    return@launch
                }
                onSubmit(request.copy(attachments = blocks))
            }
        }
        Unit
    }


    Scaffold(
        containerColor = colors.bgBase,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.create_title), style = LodyTheme.typography.headline, color = colors.textPrimary) },
                navigationIcon = {
                    val back = stringResource(R.string.chat_back)
                    IconButton(onClick = onBack, enabled = !busy, modifier = Modifier.semantics { contentDescription = back }) {
                        Icon(LodyIcons.Back, contentDescription = null, tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.bgBase, scrolledContainerColor = colors.bgBase),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .navigationBarsPadding()
                .pointerInput(dismissKeyboard) { detectTapGestures(onTap = { dismissKeyboard(); openContext = null }) },
        ) {
            // Bottom-aligned above the composer; an expanded list grows upward and, once the
            // panel outgrows the space, scrolls (anchored at its bottom).
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.BottomStart) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState(), reverseScrolling = true)
                        .padding(horizontal = LodyLayout.screenPaddingX),
                    verticalArrangement = Arrangement.spacedBy(LodySpacing.xs),
                ) {
                    ContextPanel(catalog, target, onSearchFocus = { searchFocused = it }, open = openContext, onOpenChange = { openContext = it },
                        availableMachines = options?.agents?.map { it.machineId }?.toSet().takeIf { onlineMachines != null },
                        onlineMachines = onlineMachines,
                        onChange = { if (!attempted) { targetChosen = true; target = it } })
                    if (github) BranchLine(branches, branchLoading, branchFailed, enabled = !attempted,
                        onSearchFocus = { searchFocused = it }, open = openContext == "branch", onOpenChange = { openContext = if (it) "branch" else null },
                        onChange = { name ->
                            branches = branches.select(name)
                            val selectedRepo = branchRepo
                            scope.launch {
                                try { repository.selectBranch(runtimeScope, selectedRepo, name) }
                                catch (cancelled: CancellationException) { throw cancelled }
                                catch (_: Exception) { }
                            }
                        },
                        onMore = { if (!branchLoading) { if (!branchFailed) branchPage = branches.page?.nextPage ?: 1; branchAttempt++ } })
                }
            }
            val modelName = capability?.models?.firstOrNull { it.id == modelId }?.name
            val modeName = capability?.modes?.firstOrNull { it.id == modeId }?.name
            // Keep composer state mounted, but place it under the IME during picker search.
            Box(Modifier.graphicsLayer { alpha = if (coverComposer) 0f else 1f }.layout { measurable, constraints ->
                val child = measurable.measure(constraints)
                layout(child.width, if (coverComposer) 0 else child.height) { child.placeRelative(0, 0) }
            }) {
                DropdownMenu(expanded = attachMenu, onDismissRequest = { attachMenu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.chat_attach_photos)) },
                        leadingIcon = { Icon(LodyIcons.Image, null) },
                        onClick = { attachMenu = false; photoPicker.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageAndVideo)) })
                    DropdownMenuItem(text = { Text(stringResource(R.string.chat_attach_files)) },
                        leadingIcon = { Icon(LodyIcons.File, null) },
                        onClick = { attachMenu = false; filePicker.launch(arrayOf("*/*")) })
                }
                Composer(
                    field,
                    onPromptChange = { if (!attempted && it.text.length <= 32000) { field = app.lody.android.chat.MentionPresentation.edit(field, it); prompt = field.text } },
                    onFocusChange = { composerFocused = it },
                referencePresentation = mentions.presentation(LodyTheme.colors.accentOnSubtle, LodyTheme.colors.accentSubtle),
                    attachments = attachments,
                    onRemoveAttachment = { id -> if (!busy) attachments = attachments.filterNot { it.id == id } },
                    busy = busy,
                    onAttach = { if (!busy) attachMenu = true },
                    onRunConfig = { dismissKeyboard(); if (!attempted) runConfig = true },
                    onSend = send,
                    enabled = canSend,
                    agentReady = agent != null,
                    agentCliType = agent?.cliType,
                    agentType = agent?.agentType,
                    roleEmoji = activeRole?.role?.emoji,
                    roleName = activeRole?.role?.name,
                    agentName = agent?.name,
                    face = listOfNotNull(modelName ?: agent?.name, effort),
                    mode = modeId,
                    modeLabel = modeName,
                    waiting = waitingText,
                )
            }
            // @ references, docked between the prompt and the keyboard as in a conversation; they
            // come from the chosen project, computer and agent (iOS creation `MentionSource`).
            val mentionSource = MentionSource(
                projectId = target.projectId.takeUnless { target.chat }, machineId = target.machineId,
                agentConfigId = agent?.id, cliType = agent?.cliType, agentType = agent?.agentType,
            )
            LaunchedEffect(runtimeScope, mentionSource) {
                if (mentionSource.machineId == null) return@LaunchedEffect
                mentions.load(runtimeScope) { category -> repository.mentions(runtimeScope, category, mentionSource) }
            }
            app.lody.android.chat.MentionDock(
                mentions, field, active = composerFocused && !attempted && !coverComposer,
                loadShortcut = { shortcutId -> repository.shortcut(runtimeScope, shortcutId) },
            ) { next -> if (!attempted) { field = next; prompt = next.text } }
        }
    }
    if (runConfig) {
        ModalBottomSheet(
            onDismissRequest = { runConfig = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = colors.bgBase,
        ) {
            if (agents.isEmpty()) {
                Text(
                    stringResource(if (optionsFresh) R.string.create_no_available_agents else R.string.create_waiting_agents),
                    style = LodyTheme.typography.body,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(LodyLayout.screenPaddingX),
                )
            }
            val pickRole: (String) -> Unit = { id ->
                roleItems.firstOrNull { it.role.id == id && it.unavailable == null }?.let { item ->
                    val choice = CreateSessionModel.roleChoice(item.target)
                    agentId = item.target.agentConfigId; modelId = choice.modelId; modeId = choice.modeId; effort = choice.effort
                    roleId = item.role.id
                }
            }
            val currentKey = agent?.let { CreateSessionModel.recentKey(it.machineId, RunSelection(it.id, modelId, modeId, effort), activeRole?.role?.id) }
            val recents = CreateSessionModel.recentItems(runPrefs?.recents.orEmpty(), target.machineId, agents, roleItems, currentKey)
            RunConfigSheet(
                // Web's "Recently used": whole configurations, read like the chip; a pick applies all of it.
                recents = recents.mapNotNull { record ->
                    val recentAgent = agents.firstOrNull { it.id == record.selection.agentId } ?: return@mapNotNull null
                    val recentCapability = options?.capability(recentAgent)
                    val role = record.agentRoleId?.let { id -> roleItems.firstOrNull { it.role.id == id } }
                    val selection = record.selection
                    PickerOption(
                        CreateSessionModel.recentKey(record), role?.role?.name ?: recentAgent.name, selected = false,
                        subtitle = listOfNotNull(
                            selection.modelId?.let { id -> recentCapability?.models?.firstOrNull { it.id == id }?.name ?: id },
                            selection.effort,
                            selection.modeId?.let { id -> recentCapability?.modes?.firstOrNull { it.id == id }?.name ?: id },
                        ).joinToString(" · "),
                        agent = (recentAgent.cliType to recentAgent.agentType).takeIf { role == null },
                        emoji = role?.role?.emoji,
                    )
                },
                onRecent = { key ->
                    recents.firstOrNull { CreateSessionModel.recentKey(it) == key }?.let { record ->
                        // Recorded as a Role: re-apply the Role, whose instruction rides with it.
                        val recordedRole = record.agentRoleId
                        if (recordedRole != null) pickRole(recordedRole)
                        else {
                            val recentAgent = agents.firstOrNull { it.id == record.selection.agentId }
                            if (recentAgent != null) {
                                val applied = CreateSessionModel.applicable(record.selection, options?.capability(recentAgent))
                                agentId = applied.agentId; modelId = applied.modelId; modeId = applied.modeId; effort = applied.effort
                                roleId = null
                            }
                        }
                    }
                    runConfig = false
                },
                rows = buildList {
                    // Role sits above Agent because a Role answers every row under it (web). Shown
                    // once Roles are listed, even with none to pick: then it reads None.
                    if (roles != null && agents.isNotEmpty()) {
                        val reasons = mapOf(
                            CreateSessionModel.RoleUnavailable.Machine to stringResource(R.string.create_role_unavailable_machine),
                            CreateSessionModel.RoleUnavailable.Agent to stringResource(R.string.create_role_unavailable_agent),
                            CreateSessionModel.RoleUnavailable.Offline to stringResource(R.string.create_role_unavailable_offline),
                        )
                        add(RunConfigRow(ROLE, stringResource(R.string.create_role),
                            // An empty glyph keeps None's title in line with the Roles' emoji.
                            listOf(PickerOption(ROLE_NONE, stringResource(R.string.create_role_none), activeRole == null, emoji = "")) +
                                roleItems.map { item ->
                                    PickerOption(item.role.id, item.role.name, item.role.id == activeRole?.role?.id,
                                        subtitle = item.unavailable?.let { reasons.getValue(it) }.orEmpty(),
                                        disabled = item.unavailable != null, emoji = item.role.emoji)
                                }))
                    }
                    if (agents.isNotEmpty()) add(RunConfigRow(AGENT, stringResource(R.string.create_agent), agents.map { PickerOption(it.id, it.name, it.id == agent?.id, agent = it.cliType to it.agentType) }))
                    capability?.models?.takeIf { it.isNotEmpty() }?.let { models ->
                        add(RunConfigRow(MODEL, stringResource(R.string.create_model), models.map { PickerOption(it.id, it.name, it.id == modelId) }))
                    }
                    capability?.effortsFor(modelId)?.takeIf { it.isNotEmpty() }?.let { efforts ->
                        add(RunConfigRow(EFFORT, stringResource(R.string.create_effort), efforts.map { PickerOption(it, it, it == effort) }))
                    }
                    capability?.modes?.takeIf { it.isNotEmpty() }?.let { modes ->
                        add(RunConfigRow(MODE, stringResource(R.string.create_mode), modes.map { PickerOption(it.id, it.name, it.id == modeId) }))
                    }
                },
                defaultLabel = stringResource(R.string.create_default),
            ) { row, id ->
                when (row) {
                    // None clears the name, not the values it seeded; picking a Role sets its
                    // agent and exactly what it pins.
                    ROLE -> if (id == ROLE_NONE) roleId = null else pickRole(id)
                    AGENT -> { agentId = id; modelId = null; modeId = null; effort = null }
                    MODEL -> { modelId = id; effort = null }
                    EFFORT -> effort = id
                    MODE -> modeId = id
                }
            }
        }
    }
}

private const val ROLE = "role"
private const val ROLE_NONE = "__none__"
private const val AGENT = "agent"
private const val MODEL = "model"
private const val EFFORT = "effort"
private const val MODE = "mode"

@Composable
private fun ContextPanel(catalog: CatalogSnapshot, target: CreateTarget, onSearchFocus: (Boolean) -> Unit, open: String?, onOpenChange: (String?) -> Unit, onlineMachines: Set<String>?, availableMachines: Set<String>?, onChange: (CreateTarget) -> Unit) {
    // One list open at a time, as web's picker coordinator.
    val dismissKeyboard = rememberKeyboardDismissal()
    val toggle = { id: String -> dismissKeyboard(); onOpenChange(if (open == id) null else id) }

    val machines = CreateSessionModel.machines(catalog, onlineMachines)
    val machineName = machines.firstOrNull { it.first == target.machineId }?.second
    val unavailableMachine = stringResource(R.string.create_machine_no_agents)
    val offlineMachine = stringResource(R.string.home_offline)
    PickerCard(
        onSearchFocus = onSearchFocus,
        icon = machineIcon(catalog, target.machineId),
        title = machineName ?: stringResource(R.string.create_pick_machine),
        placeholder = machineName == null,
        options = if (CreateSessionModel.machineChoosable(catalog)) machines.map { (id, name) ->
            val offline = onlineMachines != null && id !in onlineMachines
            val unavailable = availableMachines != null && id !in availableMachines
            PickerOption(id, name, selected = id == target.machineId, icon = machineIcon(catalog, id),
                subtitle = if (offline) offlineMachine else if (unavailable) unavailableMachine else "", disabled = offline || unavailable)
        } else emptyList(),
        open = open == MACHINE,
        onToggle = { toggle(MACHINE) },
        onPick = { onOpenChange(null); onChange(CreateSessionModel.pickMachine(catalog, target, it)) },
        searchPlaceholder = stringResource(R.string.create_search_machines),
    )

    val projects = CreateSessionModel.projects(catalog)
    val project = projects.firstOrNull { it.id == target.projectId }
    val chatLabel = stringResource(R.string.create_chat_only)
    val chatOption = PickerOption(CHAT, chatLabel, selected = target.chat, icon = LodyIcons.Close)
    val usable = projects.filter { CreateSessionModel.isUsable(it, target) }
    PickerCard(
        onSearchFocus = onSearchFocus,
        icon = when {
            target.chat -> LodyIcons.Close
            CreateSessionModel.isGithub(project?.id) -> LodyIcons.Github
            CreateSessionModel.isGroup(project?.id) -> LodyIcons.ProjectGroup
            else -> LodyIcons.Folder
        },
        title = if (target.chat) chatLabel else project?.name ?: stringResource(R.string.create_pick_project),
        placeholder = !target.chat && project == null,
        // No project, the five most recent, then More projects…; search covers every project.
        options = listOf(chatOption) + CreateSessionModel.recent(catalog, target).map { it.option(target) } +
            PickerOption(MORE, stringResource(R.string.create_more_projects), selected = false, icon = LodyIcons.More),
        searchOptions = listOf(chatOption) + usable.map { it.option(target) },
        searchPlaceholder = stringResource(R.string.create_search_projects),
        scopeLabel = machineName.orEmpty(),
        repository = project?.repoFullName ?: project?.id?.removePrefix("github:")?.takeIf { CreateSessionModel.isGithub(project.id) },
        open = open == PROJECT,
        onToggle = { toggle(PROJECT) },
        onPick = { id ->
            when (id) {
                MORE -> Unit // More expands the list to every project in place.
                CHAT -> { onOpenChange(null); onChange(CreateSessionModel.chat(catalog, target)) }
                else -> { onOpenChange(null); onChange(CreateSessionModel.select(catalog, target, id)) }
            }
        },
        expandAllOn = MORE,
    )

    val local = !target.chat && project != null && !CreateSessionModel.isGithub(project.id) && !CreateSessionModel.isGroup(project.id)
    if (local) WorktreeChip(target.worktree) { dismissKeyboard(); onChange(target.copy(worktree = it)) }
}

/** iOS draws SF Symbols by OS; Android uses the matching Lucide marks. */
private fun machineIcon(catalog: CatalogSnapshot, id: String?): ImageVector = when (CreateSessionModel.machineKind(catalog, id)) {
    CreateSessionModel.MachineKind.Laptop -> LodyIcons.Machine
    CreateSessionModel.MachineKind.Desktop -> LodyIcons.Desktop
    CreateSessionModel.MachineKind.Server -> LodyIcons.Server
}

private const val MACHINE = "machine"
private const val PROJECT = "project"
private const val CHAT = "chat"
private const val MORE = "more"

internal data class PickerOption(
    val id: String,
    val title: String,
    val selected: Boolean,
    val subtitle: String = "",
    val icon: ImageVector? = null,
    val disabled: Boolean = false,
    /** An agent's provider (cliType to agentType): leads with its mark instead of [icon]. */
    val agent: Pair<String, String>? = null,
    /** An Agent Role's emoji, shown instead of an icon. */
    val emoji: String? = null,
    val repository: String? = null,
)

/** The option's leading mark: the agent's provider mark, else its icon. */
@Composable
private fun OptionMark(option: PickerOption, size: androidx.compose.ui.unit.Dp) {
    val tint = LodyTheme.colors.iconSecondary
    when {
        option.repository != null -> app.lody.android.home.RepositoryIcon(option.repository, size, opacity = 0.8f)
        option.emoji != null -> Box(Modifier.size(size), contentAlignment = Alignment.Center) {
            Text(option.emoji, fontSize = with(androidx.compose.ui.platform.LocalDensity.current) { (size * 0.85f).toSp() })
        }
        option.agent != null -> AgentMark(option.agent.first, option.agent.second, tint, Modifier.size(size))
        option.icon != null -> Icon(option.icon, contentDescription = null, tint = tint, modifier = Modifier.size(size))
    }
}

private fun CatalogProject.option(target: CreateTarget) = PickerOption(
    repository = repoFullName ?: id.removePrefix("github:").takeIf { CreateSessionModel.isGithub(id) },
    id = id,
    title = name,
    selected = !target.chat && id == target.projectId,
    // A group's row carries "N repositories" (put in its rootPath when the groups are listed).
    subtitle = if (CreateSessionModel.isGithub(id)) "GitHub" else rootPath.replace(Regex("^/(Users|home)/[^/]+"), "~"),
    icon = when {
        CreateSessionModel.isGithub(id) -> LodyIcons.Github
        CreateSessionModel.isGroup(id) -> LodyIcons.ProjectGroup
        else -> LodyIcons.Folder
    },
)

/**
 * A plain full-width line (no fill, as iOS); its options expand in place right below it. The
 * panel is bottom-anchored, so the list is revealed from its top edge and moves up with the
 * layout instead of sliding against it.
 */
@Composable
private fun PickerCard(
    icon: ImageVector,
    title: String,
    placeholder: Boolean,
    options: List<PickerOption>,
    open: Boolean,
    onToggle: () -> Unit,
    onPick: (String) -> Unit,
    searchOptions: List<PickerOption>? = null,
    searchPlaceholder: String = "",
    expandAllOn: String? = null,
    onSearchFocus: (Boolean) -> Unit = {},
    scopeLabel: String = "",
    repository: String? = null,
) {
    val colors = LodyTheme.colors
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = LodySize.controlLg)
                .clip(RoundedCornerShape(LodyRadius.md))
                .clickable(enabled = options.isNotEmpty(), role = Role.Button, onClick = onToggle)
                .semantics { contentDescription = title }
                .padding(horizontal = LodySpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
        ) {
            if (repository != null) app.lody.android.home.RepositoryIcon(repository, LodyIconSize.md, opacity = 0.8f)
            else Icon(icon, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.md))
            Text(
                title,
                style = LodyTheme.typography.body,
                color = if (placeholder) colors.textTertiary else colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
                modifier = Modifier.weight(1f),
            )
            if (options.isNotEmpty()) PopupIndicator()
        }
        AnimatedVisibility(
            open,
            enter = expandVertically(expandFrom = Alignment.Top) + fadeIn(),
            exit = shrinkVertically(shrinkTowards = Alignment.Top) + fadeOut(),
        ) {
            Column {
                if (scopeLabel.isNotEmpty()) {
                    Text(
                        scopeLabel,
                        style = LodyTheme.typography.footnote,
                        color = colors.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(horizontal = LodySpacing.xs, vertical = LodySpacing.xs),
                    )
                }
                OptionList(options, searchOptions, searchPlaceholder, onPick, expandAllOn, onSearchFocus = onSearchFocus)
            }
        }
    }
}

/** The pop-up indicator (⌃⌄), drawn as a stacked up / down pair. */
@Composable
private fun PopupIndicator() {
    val tint = LodyTheme.colors.iconTertiary
    Column {
        Icon(LodyIcons.Collapse, contentDescription = null, tint = tint, modifier = Modifier.size(LodyIconSize.xs))
        Icon(LodyIcons.Expand, contentDescription = null, tint = tint, modifier = Modifier.size(LodyIconSize.xs))
    }
}

/** The expanded options, aligned with the line (no indent or surface): search, then rows. */
@Composable
private fun OptionList(
    options: List<PickerOption>,
    searchOptions: List<PickerOption>?,
    searchPlaceholder: String,
    onPick: (String) -> Unit,
    expandAllOn: String?,
    expandsToContent: Boolean = false,
    onSearchFocus: (Boolean) -> Unit = {},
) {
    val dismissKeyboard = rememberKeyboardDismissal()
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    var query by remember { mutableStateOf("") }
    var all by remember { mutableStateOf(false) }
    val term = query.trim()
    val shown = when {
        term.isNotEmpty() -> (searchOptions ?: options).filter { "${it.title} ${it.subtitle}".contains(term, ignoreCase = true) }
        all && searchOptions != null -> searchOptions
        else -> options
    }
    Column(Modifier.fillMaxWidth()) {
        if (searchOptions != null || options.size > 8) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = LodySize.controlMd).padding(horizontal = LodySpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
            ) {
                Icon(LodyIcons.Search, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.md))
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    singleLine = true,
                    textStyle = type.body.copy(color = colors.textPrimary),
                    cursorBrush = SolidColor(colors.accentDefault),
                    modifier = Modifier.weight(1f).onFocusChanged { onSearchFocus(it.isFocused) },
                    decorationBox = { inner ->
                        Box {
                            if (query.isEmpty()) Text(searchPlaceholder, style = type.body, color = colors.textPlaceholder)
                            inner()
                        }
                    },
                )
            }
        }
        val optionContent: @Composable (PickerOption) -> Unit = { option ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = LodySize.listRow)
                        .clip(RoundedCornerShape(LodyRadius.md))
                        .clickable(enabled = !option.disabled, role = Role.Button) { dismissKeyboard(); if (option.id == expandAllOn) all = true; onPick(option.id) }
                        .semantics { selected = option.selected }
                        .padding(horizontal = LodySpacing.xs, vertical = LodySpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
                ) {
                    OptionMark(option, LodyIconSize.md)
                    Column(Modifier.weight(1f)) {
                        Text(option.title, style = type.body, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (option.subtitle.isNotEmpty()) {
                            Text(option.subtitle, style = type.footnote, color = colors.textTertiary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                        }
                    }
                    if (option.selected) Icon(LodyIcons.Check, contentDescription = null, tint = colors.accentFg, modifier = Modifier.size(LodyIconSize.sm))
                }
        }
        if (expandsToContent) {
            Column { shown.forEach { option -> androidx.compose.runtime.key(option.id) { optionContent(option) } } }
        } else {
            LazyColumn(Modifier.heightIn(max = 280.dp)) {
                items(shown, key = { it.id }) { option -> optionContent(option) }
            }
        }
    }
}

/** Web's worktree chip as iOS draws it: a checkbox and the word, no fill. */
@Composable
private fun WorktreeChip(on: Boolean, onChange: (Boolean) -> Unit) {
    val colors = LodyTheme.colors
    Row(
        modifier = Modifier
            .heightIn(min = LodySize.controlMd)
            .clip(RoundedCornerShape(LodyRadius.md))
            .toggleable(value = on, role = Role.Checkbox, onValueChange = onChange)
            .padding(horizontal = LodySpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
    ) {
        androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalMinimumInteractiveComponentSize provides 0.dp) {
            androidx.compose.material3.Checkbox(
                checked = on, onCheckedChange = null,
                modifier = Modifier.size(LodyIconSize.md),
                colors = androidx.compose.material3.CheckboxDefaults.colors(
                    checkedColor = colors.accentSolid, uncheckedColor = colors.borderDefault,
                    checkmarkColor = colors.textOnAccent,
                ),
            )
        }
        Text(stringResource(R.string.create_worktree), style = LodyTheme.typography.subhead, color = colors.textSecondary)
    }
}

/** Cached choices stay interactive while the next snapshot loads. */
@Composable
private fun BranchLine(state: BranchState, loading: Boolean, failed: Boolean, enabled: Boolean, onSearchFocus: (Boolean) -> Unit, open: Boolean, onOpenChange: (Boolean) -> Unit, onChange: (String) -> Unit, onMore: () -> Unit) {
    var query by remember { mutableStateOf("") }
    val dismissKeyboard = rememberKeyboardDismissal()
    val colors = LodyTheme.colors
    Column {
        Row(Modifier.fillMaxWidth().heightIn(min = LodySize.controlMd).clickable(enabled = enabled) { dismissKeyboard(); onOpenChange(!open) }
            .padding(horizontal = LodySpacing.xs), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
            Icon(LodyIcons.Branch, null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.md))
            Text(state.selected.ifEmpty { stringResource(R.string.create_branch_name) }, style = LodyTheme.typography.body,
                color = if (state.selected.isEmpty()) colors.textPlaceholder else colors.textPrimary, modifier = Modifier.weight(1f))
            if (loading && state.page == null) app.lody.android.designsystem.LodyLoadingIndicator(Modifier.size(LodyIconSize.sm))
            else PopupIndicator()
        }
        if (open) {
            BasicTextField(value = query, onValueChange = { query = it }, singleLine = true,
                textStyle = LodyTheme.typography.body.copy(color = colors.textPrimary),
                modifier = Modifier.fillMaxWidth().padding(LodySpacing.sm).onFocusChanged { onSearchFocus(it.isFocused) },
                decorationBox = { field -> Box { if (query.isEmpty()) Text(stringResource(R.string.create_search_branches), style = LodyTheme.typography.body, color = colors.textPlaceholder); field() } })
            LazyColumn(Modifier.heightIn(max = LodySize.controlMd * 6)) {
              items(state.page?.names.orEmpty().filter { it.contains(query.trim(), ignoreCase = true) }, key = { it }) { name ->
                Row(Modifier.fillMaxWidth().heightIn(min = LodySize.controlMd).clickable(enabled = enabled) { dismissKeyboard(); onChange(name); onOpenChange(false) }
                    .padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
                    Text(name, style = LodyTheme.typography.body, color = colors.textPrimary, modifier = Modifier.weight(1f))
                    if (name == state.selected) Icon(LodyIcons.Check, null, tint = colors.accentFg, modifier = Modifier.size(LodyIconSize.sm))
                }
            }
            }
            if (failed || state.page?.nextPage != null || (loading && state.page == null)) {
                TextButton(onClick = { dismissKeyboard(); onMore() }, enabled = enabled && !loading) {
                    if (loading) app.lody.android.designsystem.LodyLoadingIndicator(Modifier.size(LodyIconSize.sm))
                    else Text(stringResource(if (failed) R.string.chat_retry else R.string.create_more_branches))
                }
            }
        }
    }
}

/**
 * One run-config row. [toggle] makes it a switch (web's Plan / Fast) that picks "on" / "off";
 * a [locked] row shows its selected option and cannot be opened (the Agent in a conversation).
 */
internal data class RunConfigRow(val id: String, val label: String, val options: List<PickerOption>, val toggle: Boolean? = null, val locked: Boolean = false)

internal const val RUN_CONFIG_ON = "on"
internal const val RUN_CONFIG_OFF = "off"

/** Web's run-config sheet as iOS draws it: label + value rows whose options expand in place. */
@Composable
internal fun RunConfigSheet(
    rows: List<RunConfigRow>,
    defaultLabel: String,
    recents: List<PickerOption> = emptyList(),
    onRecent: (String) -> Unit = {},
    onPick: (String, String) -> Unit,
) {
    val colors = LodyTheme.colors
    var open by remember { mutableStateOf<String?>(null) }
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = LodyLayout.screenPaddingX).padding(bottom = LodySpacing.lg),
        verticalArrangement = Arrangement.spacedBy(LodySpacing.xs),
    ) {
        Text(
            stringResource(R.string.create_run_config),
            style = LodyTheme.typography.headline,
            color = colors.textPrimary,
            modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = LodySpacing.sm),
        )
        if (recents.isNotEmpty()) {
            Text(
                stringResource(R.string.create_run_config_recent),
                style = LodyTheme.typography.footnote,
                color = colors.textTertiary,
                modifier = Modifier.padding(horizontal = LodySpacing.xs),
            )
            OptionList(recents, null, "", onRecent, null, expandsToContent = true)
            HorizontalDivider(color = colors.borderSubtle, modifier = Modifier.padding(vertical = LodySpacing.xs))
        }
        rows.forEach { row ->
            val current = row.options.firstOrNull { it.selected }
            if (row.toggle != null) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = LodySize.controlLg)
                        .clip(RoundedCornerShape(LodyRadius.md))
                        .clickable(role = Role.Switch) { onPick(row.id, if (row.toggle) RUN_CONFIG_OFF else RUN_CONFIG_ON) }
                        .padding(horizontal = LodySpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(row.label, style = LodyTheme.typography.subhead, color = colors.textSecondary, modifier = Modifier.weight(1f))
                    androidx.compose.material3.Switch(checked = row.toggle, onCheckedChange = { onPick(row.id, if (it) RUN_CONFIG_ON else RUN_CONFIG_OFF) })
                }
                return@forEach
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = LodySize.controlLg)
                    .clip(RoundedCornerShape(LodyRadius.md))
                    .clickable(enabled = !row.locked, role = Role.Button) { open = if (open == row.id) null else row.id }
                    .padding(horizontal = LodySpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
            ) {
                Text(row.label, style = LodyTheme.typography.subhead, color = colors.textSecondary, modifier = Modifier.widthIn(min = RunConfigLabelWidth))
                if (current != null) OptionMark(current, LodyIconSize.sm)
                Text(
                    current?.title ?: defaultLabel,
                    style = LodyTheme.typography.body,
                    color = if (current == null) colors.textTertiary else colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (!row.locked) PopupIndicator()
            }
            AnimatedVisibility(
                open == row.id,
                enter = expandVertically(expandFrom = Alignment.Top) + fadeIn(),
                exit = shrinkVertically(shrinkTowards = Alignment.Top) + fadeOut(),
            ) {
                OptionList(row.options, null, "", { id -> open = null; onPick(row.id, id) }, null, expandsToContent = true)
            }
        }
    }
}

private val RunConfigLabelWidth = LodySize.controlLg * 2

/**
 * Web's mobile composer on a floating surface (Android has no Liquid Glass; the Home tab bar's
 * overlay + shadow stands in): prompt, then + and the run-config chip leading, send trailing.
 * No @ button, as web and iOS. One line at rest; three while editing.
 */
@Composable
private fun Composer(
    prompt: androidx.compose.ui.text.input.TextFieldValue,
    onPromptChange: (androidx.compose.ui.text.input.TextFieldValue) -> Unit,
    onFocusChange: (Boolean) -> Unit,
    referencePresentation: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
    attachments: List<PendingAttachment>,
    onRemoveAttachment: (String) -> Unit,
    busy: Boolean,
    onAttach: () -> Unit,
    onRunConfig: () -> Unit,
    onSend: () -> Unit,
    enabled: Boolean,
    agentReady: Boolean,
    agentCliType: String?,
    agentType: String?,
    roleEmoji: String?,
    roleName: String?,
    agentName: String?,
    face: List<String>,
    mode: String?,
    modeLabel: String?,
    waiting: String,
) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val shape = RoundedCornerShape(LodyRadius.xl)
    // Web's landing prompt: "Work with <assistant>" once one is chosen — the Agent Role when one is.
    val workWith = roleName ?: agentName
    val placeholder = if (workWith.isNullOrEmpty()) stringResource(R.string.create_composer_placeholder)
        else stringResource(R.string.create_composer_placeholder_agent, workWith)
    var focused by remember { mutableStateOf(false) }
    Column(
        Modifier
            .padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.sm)
            .fillMaxWidth()
            .dropShadow(shape, LodyElevations.md.shadow())
            .clip(shape)
            .background(colors.bgOverlay, shape)
            .animateContentSize()
            .padding(LodySpacing.sm),
    ) {
        if (attachments.isNotEmpty()) {
            val remove = stringResource(R.string.chat_attach_remove)
            androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
                items(attachments, key = { it.id }) { item ->
                    AttachmentChip(item.name, item.image) {
                        IconButton(onClick = { onRemoveAttachment(item.id) }, enabled = !busy) {
                            Icon(LodyIcons.Close, "$remove ${item.name}", modifier = Modifier.size(LodyIconSize.xs))
                        }
                    }
                }
            }
        }
        if (busy) androidx.compose.material3.LinearProgressIndicator(Modifier.fillMaxWidth())
        BasicTextField(
            readOnly = busy,
            value = prompt,
            visualTransformation = referencePresentation,
            onValueChange = onPromptChange,
            textStyle = type.body.copy(color = colors.textPrimary),
            cursorBrush = SolidColor(colors.accentDefault),
            minLines = if (focused) 3 else 1,
            maxLines = 10,
            modifier = Modifier
                .fillMaxWidth()
                .onFocusChanged { focused = it.isFocused; onFocusChange(it.isFocused) }
                .padding(horizontal = LodySpacing.sm, vertical = LodySpacing.xs)
                .semantics { contentDescription = placeholder },
            decorationBox = { inner ->
                Box {
                    if (prompt.text.isEmpty()) Text(placeholder, style = type.body, color = colors.textPlaceholder)
                    inner()
                }
            },
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            ComposerButton(LodyIcons.Plus, stringResource(R.string.create_attach), onAttach)
            // The run-config chip: assistant mark + model · effort · mode (mode dimmed), as iOS.
            Row(
                Modifier
                    .weight(1f)
                    .heightIn(min = LodySize.controlMd)
                    .clip(RoundedCornerShape(LodyRadius.md))
                    .clickable(role = Role.Button, onClick = onRunConfig)
                    .padding(horizontal = LodySpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
            ) {
                // An Agent Role leads with its emoji instead of the assistant's mark (web's Role face).
                if (roleEmoji != null) Text(roleEmoji, style = type.subhead)
                else AgentMark(agentCliType, agentType, colors.iconSecondary, Modifier.size(LodyIconSize.sm))
                fun label(named: Boolean) = buildAnnotatedString {
                    if (!agentReady || face.isEmpty()) {
                        withStyle(SpanStyle(color = colors.textTertiary)) { append(waiting) }
                    } else {
                        // With the Role's name, model · effort recede to secondary ink.
                        if (named) withStyle(SpanStyle(color = colors.textPrimary)) { append(roleName.orEmpty()); append("   ") }
                        face.forEachIndexed { index, part ->
                            if (index > 0) withStyle(SpanStyle(color = colors.textTertiary)) { append("  ·  ") }
                            withStyle(SpanStyle(color = if (named) colors.textSecondary else colors.textPrimary)) { append(part) }
                        }
                    }
                }
                // The Role's name only when the whole face fits; otherwise the emoji alone marks it.
                androidx.compose.foundation.layout.BoxWithConstraints(Modifier.weight(1f, fill = false)) {
                    val measurer = androidx.compose.ui.text.rememberTextMeasurer()
                    val named = label(named = true)
                    val fits = !roleName.isNullOrEmpty() &&
                        measurer.measure(named, type.subhead, maxLines = 1).size.width <= constraints.maxWidth
                    Text(if (fits) named else label(named = false), style = type.subhead, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                ModeMark(mode, modeLabel)

            }
            val ready = enabled && (prompt.text.isNotBlank() || attachments.isNotEmpty())
            val send = stringResource(R.string.create_send)
            LodyFilledIconButton(
                onClick = onSend, enabled = ready,
                modifier = Modifier.size(LodySize.controlSm).semantics { contentDescription = send },
                colors = androidx.compose.material3.IconButtonDefaults.filledIconButtonColors(
                    containerColor = colors.accentSolid, contentColor = colors.textOnAccent,
                    disabledContainerColor = colors.fillSecondary, disabledContentColor = colors.iconTertiary,
                ),
            ) {
                Icon(LodyIcons.Send, contentDescription = null, tint = if (ready) colors.textOnAccent else colors.iconTertiary, modifier = Modifier.size(LodyIconSize.sm))
            }
        }
    }
}

/** The run-config chip's permission face: a glyph per known mode, `Auto` for auto modes, else nothing. */
@Composable
internal fun ModeMark(mode: String?, label: String?) {
    val colors = LodyTheme.colors
    val warning = mode in listOf("agent-full-access", "danger-full-access", "dontAsk", "bypassPermissions", "yolo", "always-approve")
    val icon = when {
        warning -> LodyIcons.PermissionWarning
        mode == "agent" || mode == "default" -> LodyIcons.PermissionDefault
        mode == "read-only" -> LodyIcons.Eye
        mode == "acceptEdits" -> LodyIcons.Edit
        mode == "plan" -> LodyIcons.PermissionPlan
        else -> null
    }
    if (icon != null) Icon(icon, contentDescription = label, tint = if (warning) colors.warningDefault else colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
    if (mode == "auto" || mode == "agent-auto-review") Text(stringResource(R.string.create_mode_auto), style = LodyTheme.typography.caption, color = colors.textSecondary)
}

@Composable
private fun ComposerButton(icon: ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.semantics { contentDescription = label }.widthIn(min = LodySize.controlMd)) {
        Icon(icon, contentDescription = null, tint = LodyTheme.colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
    }
}

/** Clear focus as well as hiding IME so it does not reopen after a picker closes. */
@Composable
private fun rememberKeyboardDismissal(): () -> Unit {
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    return remember(focus, keyboard) { { focus.clearFocus(); keyboard?.hide(); Unit } }
}
