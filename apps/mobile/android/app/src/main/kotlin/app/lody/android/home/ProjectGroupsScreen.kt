package app.lody.android.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import app.lody.android.R
import app.lody.android.create.CreationService
import app.lody.android.designsystem.*
import app.lody.android.runtime.ProjectGroup
import app.lody.android.runtime.RuntimeScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Where a group runs, for Settings › Projects (iOS `ProjectGroupSections.place`). */
internal sealed interface ProjectGroupPlace {
    data class Computer(val name: String) : ProjectGroupPlace
    data object Any : ProjectGroupPlace
    /** Local members on two computers: it cannot start a conversation. */
    data object Conflict : ProjectGroupPlace
}

/** Pure projection of Settings › Projects' Project groups. */
internal object ProjectGroupsModel {
    fun sorted(groups: List<ProjectGroup>): List<ProjectGroup> =
        groups.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })

    fun place(group: ProjectGroup, machineNames: Map<String, String>): ProjectGroupPlace = when {
        group.conflict -> ProjectGroupPlace.Conflict
        group.machineId.isNullOrEmpty() -> ProjectGroupPlace.Any
        else -> group.machineId.orEmpty().let { id -> ProjectGroupPlace.Computer(machineNames[id]?.takeIf { it.isNotEmpty() } ?: id) }
    }

    /** Only the group's creator edits it (web `canManageWorkspaceProject`), on desktop for now. */
    fun ownedBy(group: ProjectGroup, userId: String?): Boolean = !userId.isNullOrEmpty() && group.ownerUserId == userId
}

/**
 * Settings › Projects: local project visibility per computer (iOS `ProjectVisibilityController`;
 * the owner picks Shared or Private), then the workspace's Project groups (web Settings › Projects
 * multi-repository rows), each opening a read-only page with its computer, creator and members.
 * Groups are created and edited on desktop.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ProjectGroupsScreen(home: ChatListUiState, service: CreationService?, scope: RuntimeScope?, visibilityService: ProjectVisibilityService? = null, onBack: () -> Unit) {
    val colors = LodyTheme.colors
    val tasks = rememberCoroutineScope()
    var groups by remember(scope) { mutableStateOf<List<ProjectGroup>?>(null) }
    var failed by remember(scope) { mutableStateOf(false) }
    var loading by remember(scope) { mutableStateOf(false) }
    var pulling by remember { mutableStateOf(false) }
    var openId by rememberSaveable(scope) { mutableStateOf<String?>(null) }
    suspend fun refresh() {
        if (service == null || scope == null) return
        loading = true
        try {
            groups = service.projectGroups(scope)
            failed = false
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { failed = true } // A failed read keeps the last list.
        finally { loading = false }
    }
    val visibility = remember(visibilityService, scope) { if (visibilityService != null && scope != null) ProjectVisibilityState(visibilityService, scope) else null }
    LaunchedEffect(service, scope) { refresh() }
    LaunchedEffect(visibility) { visibility?.refresh() }
    val machineNames = home.snapshot?.machineNames.orEmpty()
    val open = groups?.firstOrNull { it.id == openId }
    if (open != null) {
        ProjectGroupPage(open, home, machineNames) { openId = null }
        return
    }
    BackHandler(onBack = onBack)
    Scaffold(containerColor = colors.bgBase, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(LodyIcons.Back, stringResource(R.string.settings_agent_back)) }
            Text(stringResource(R.string.settings_projects), Modifier.weight(1f), style = LodyTheme.typography.headline, color = colors.textPrimary)
        }
    }) { padding ->
        PullToRefreshBox(
            isRefreshing = pulling,
            onRefresh = { tasks.launch { pulling = true; try { launch { visibility?.refresh() }; refresh() } finally { pulling = false } } },
            modifier = Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = padding.calculateBottomPadding() + LodySpacing.xxl)) {
                if ((loading || visibility?.loading == true || visibility?.writing == true) && !pulling) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                if (visibility != null) projectVisibility(visibility, home)
                if (failed) item(key = "notice") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = LodySpacing.lg, vertical = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
                        Icon(LodyIcons.Alert, null, Modifier.size(LodyIconSize.md), tint = colors.textSecondary)
                        Text(stringResource(if (groups == null) R.string.project_groups_load_failed else R.string.project_groups_stale),
                            Modifier.weight(1f), style = LodyTheme.typography.footnote, color = colors.textSecondary)
                        TextButton(onClick = { tasks.launch { refresh() } }) { Text(stringResource(R.string.chat_retry)) }
                    }
                }
                val list = groups ?: return@LazyColumn
                item(key = "groups") {
                    SettingsGroup(stringResource(R.string.project_groups_header)) {
                        if (list.isEmpty()) {
                            Text(stringResource(R.string.project_groups_empty), style = LodyTheme.typography.subhead, color = colors.textSecondary,
                                modifier = Modifier.padding(horizontal = LodySpacing.lg, vertical = LodySpacing.md))
                        }
                        ProjectGroupsModel.sorted(list).forEach { group ->
                            val members = pluralStringResource(R.plurals.project_group_members, group.members.size, group.members.size)
                            SettingsLine(
                                group.name.ifEmpty { stringResource(R.string.project_groups_untitled) }, LodyIcons.ProjectGroup,
                                "$members · ${placeText(ProjectGroupsModel.place(group, machineNames))}",
                                onClick = { openId = group.id },
                            )
                        }
                        Text(stringResource(R.string.project_groups_read_only), style = LodyTheme.typography.footnote, color = colors.textSecondary,
                            modifier = Modifier.padding(horizontal = LodySpacing.lg, vertical = LodySpacing.sm))
                    }
                }
            }
        }
    }
}

@Composable
private fun placeText(place: ProjectGroupPlace): String = when (place) {
    is ProjectGroupPlace.Computer -> place.name
    ProjectGroupPlace.Any -> stringResource(R.string.project_groups_any_computer)
    ProjectGroupPlace.Conflict -> stringResource(R.string.project_groups_conflict)
}

/** One group, read only: where it runs, who created it, and its members in placement order. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProjectGroupPage(group: ProjectGroup, home: ChatListUiState, machineNames: Map<String, String>, onBack: () -> Unit) {
    val colors = LodyTheme.colors
    BackHandler(onBack = onBack)
    val creator = when {
        ProjectGroupsModel.ownedBy(group, home.userId) -> stringResource(R.string.project_groups_owner_you)
        else -> home.members[group.ownerUserId]?.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.project_groups_owner_member)
    }
    Scaffold(containerColor = colors.bgBase, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(LodyIcons.Back, stringResource(R.string.settings_agent_back)) }
            Text(group.name, Modifier.weight(1f), style = LodyTheme.typography.headline, color = colors.textPrimary,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + LodySpacing.xxl)) {
            item(key = "info") {
                SettingsGroup {
                    SettingsLine(stringResource(R.string.project_groups_computer), LodyIcons.Desktop, placeText(ProjectGroupsModel.place(group, machineNames)))
                    SettingsLine(stringResource(R.string.project_groups_owner), LodyIcons.User, creator)
                }
            }
            item(key = "members") {
                SettingsGroup(pluralStringResource(R.plurals.project_group_members, group.members.size, group.members.size)) {
                    group.members.forEach { member ->
                        val local = member.kind == "local"
                        val machine = member.machineId?.let { machineNames[it] ?: it }.orEmpty()
                        Row(Modifier.fillMaxWidth().heightIn(min = LodySize.controlLg).padding(horizontal = LodySpacing.lg, vertical = LodySpacing.md),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
                            if (local) Icon(LodyIcons.Folder, null, Modifier.size(LodyIconSize.md), tint = colors.textSecondary)
                            else RepositoryIcon(member.repoFullName ?: member.label, LodyIconSize.md, opacity = 0.8f)
                            Column(Modifier.weight(1f)) {
                                Text(member.label, style = LodyTheme.typography.body, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                                Text(listOf(member.path, if (local) machine else "").filter { it.isNotEmpty() }.joinToString(" · "),
                                    style = LodyTheme.typography.footnote.copy(fontFamily = FontFamily.Monospace), color = colors.textSecondary,
                                    maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                            }
                        }
                    }
                    Text(stringResource(R.string.project_groups_read_only), style = LodyTheme.typography.footnote, color = colors.textSecondary,
                        modifier = Modifier.padding(horizontal = LodySpacing.lg, vertical = LodySpacing.sm))
                }
            }
        }
    }
}

/**
 * Local project visibility, one group per computer (iOS `ProjectVisibilitySections`): the scope
 * hint, each project with its state, and for the owner a menu of Shared / Private. Changes need a
 * live read; a failed read or an unknown write says so and offers a fresh read.
 */
private fun androidx.compose.foundation.lazy.LazyListScope.projectVisibility(state: ProjectVisibilityState, home: ChatListUiState) {
    val machines = ProjectVisibilityModel.machines(state.snapshot, home.snapshot)
    if (state.failed || state.unconfirmed) item(key = "visibility-notice") {
        val tasks = rememberCoroutineScope()
        val colors = LodyTheme.colors
        Row(Modifier.fillMaxWidth().padding(horizontal = LodySpacing.lg, vertical = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
            Icon(LodyIcons.Alert, null, Modifier.size(LodyIconSize.md), tint = colors.textSecondary)
            Text(stringResource(if (state.unconfirmed) R.string.project_visibility_unconfirmed else R.string.project_visibility_load_failed),
                Modifier.weight(1f), style = LodyTheme.typography.footnote, color = colors.textSecondary)
            TextButton(onClick = { tasks.launch { state.refresh() } }) { Text(stringResource(R.string.chat_retry)) }
        }
    }
    item(key = "visibility-hint") {
        Text(stringResource(R.string.project_visibility_hint), style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary,
            modifier = Modifier.padding(horizontal = LodySpacing.xxl, vertical = LodySpacing.sm))
    }
    if (machines.isEmpty() && state.live) item(key = "visibility-empty") {
        Text(stringResource(R.string.project_visibility_empty), style = LodyTheme.typography.subhead, color = LodyTheme.colors.textSecondary,
            modifier = Modifier.padding(horizontal = LodySpacing.xxl, vertical = LodySpacing.md))
    }
    machines.forEach { machine ->
        item(key = "visibility-machine-${machine.machineId}") {
            val name = home.snapshot?.machineNames?.get(machine.machineId)?.takeIf { it.isNotEmpty() } ?: machine.machineId
            SettingsGroup(name) { machine.items.forEach { VisibilityLine(it, state) } }
        }
    }
    if (machines.isNotEmpty()) item(key = "visibility-footer") {
        Text(stringResource(R.string.project_visibility_footer), style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary,
            modifier = Modifier.padding(horizontal = LodySpacing.xxl, vertical = LodySpacing.sm))
    }
}

@Composable
private fun VisibilityLine(item: ProjectVisibilityModel.Item, state: ProjectVisibilityState) {
    val colors = LodyTheme.colors
    val tasks = rememberCoroutineScope()
    var open by remember(item.id) { mutableStateOf(false) }
    val value = stringResource(when (item.state) {
        ProjectVisibilityModel.State.Shared -> R.string.project_visibility_shared_short
        ProjectVisibilityModel.State.Private -> R.string.project_visibility_private
        ProjectVisibilityModel.State.Unknown -> R.string.project_visibility_unknown
    })
    val glyph = when (item.state) {
        ProjectVisibilityModel.State.Shared -> LodyIcons.User
        ProjectVisibilityModel.State.Private -> LodyIcons.Lock
        ProjectVisibilityModel.State.Unknown -> LodyIcons.Info
    }
    val row = item.editable
    Box {
        SettingsLine(
            item.title, LodyIcons.Folder,
            item.path ?: stringResource(R.string.project_visibility_others),
            onClick = if (row != null && state.editable) ({ open = true }) else null,
            trailing = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
                    Icon(glyph, null, Modifier.size(LodyIconSize.sm), tint = colors.textSecondary)
                    Text(value, style = LodyTheme.typography.body, color = colors.textSecondary)
                }
            },
        )
        if (row != null) DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.align(Alignment.CenterEnd)) {
            listOf(true to R.string.project_visibility_shared, false to R.string.project_visibility_private).forEach { (shared, label) ->
                DropdownMenuItem(
                    text = { Text(stringResource(label)) },
                    leadingIcon = { Icon(if (shared) LodyIcons.User else LodyIcons.Lock, null, Modifier.size(LodyIconSize.sm)) },
                    trailingIcon = { if (row.sharedWithTeam == shared) Icon(LodyIcons.Check, null, Modifier.size(LodyIconSize.sm)) },
                    onClick = { open = false; tasks.launch { state.set(row, shared) } },
                )
            }
        }
    }
}
