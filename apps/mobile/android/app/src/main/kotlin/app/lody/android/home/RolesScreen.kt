package app.lody.android.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.util.UUID

interface RoleSettingsService {
    suspend fun perform(scope: RuntimeScope, action: RoleSettingsAction): RoleSettingsSnapshot
}
class RuntimeRoleSettingsService(private val owner: RuntimeOwner) : RoleSettingsService {
    override suspend fun perform(scope: RuntimeScope, action: RoleSettingsAction): RoleSettingsSnapshot = owner.use(scope) {
        (it.execute(RuntimeCommand.AgentRoleSettings(action)) as RuntimeResult.RoleSettings).value
    }
}

/**
 * iOS `AgentRolesController`: the last list shows at once while a live read replaces it; a cached
 * list never authorizes writes; saves and deletes show immediately and roll back on failure.
 */
internal class RolesState(private val service: RoleSettingsService, private val scope: RuntimeScope) {
    var snapshot by mutableStateOf(remembered?.takeIf { it.first == scope }?.second); private set
    var live by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    private var version = 0

    suspend fun refresh() {
        val id = ++version
        busy = true
        try {
            val next = service.perform(scope, RoleSettingsAction.List)
            if (id == version) accept(next)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { if (id == version) error = "role_load_failed" }
        finally { if (id == version) busy = false }
    }

    /** Shows [preview] (or removes [id] when null) at once; restores the list if the write fails. */
    suspend fun perform(action: RoleSettingsAction, id: String, preview: RoleSetting?): Boolean {
        if (!live) return false
        val previous = snapshot
        version++
        snapshot = previous?.let { current ->
            val others = current.roles.filterNot { it.id == id }
            current.copy(roles = (if (preview == null) others else others + preview).sortedBy { it.name.lowercase() })
        }
        busy = true; error = null
        return try {
            accept(service.perform(scope, action))
            true
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            snapshot = previous
            error = (failure as? app.lody.android.runtime.RuntimeException)?.fault?.code ?: "role_write_unknown"
            false
        } finally { busy = false }
    }

    private fun accept(next: RoleSettingsSnapshot) {
        snapshot = next; live = true; error = null
        remembered = scope to next
    }

    private companion object {
        /** Process memory only (one scope). */
        @Volatile var remembered: Pair<RuntimeScope, RoleSettingsSnapshot>? = null
    }
}

private data class RoleDraft(val base: RoleSetting?, val id: String = base?.id ?: UUID.randomUUID().toString())

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RolesScreen(home: ChatListUiState, service: RoleSettingsService?, scope: RuntimeScope?, onBack: () -> Unit) {
    val state = remember(service, scope) { if (service != null && scope != null) RolesState(service, scope) else null }
    val tasks = rememberCoroutineScope()
    var draft by remember(scope) { mutableStateOf<RoleDraft?>(null) }
    LaunchedEffect(state) { state?.refresh() }
    BackHandler { if (draft != null) draft = null else onBack() }
    val editing = draft
    if (editing != null && state != null) {
        RoleEditor(editing.base, home.userId.orEmpty(), state.snapshot?.agents.orEmpty(), state.busy, state.error,
            onBack = { draft = null },
            onSave = { fields, target ->
                val preview = RoleSetting(editing.id, home.userId.orEmpty(), fields.shared, fields.name.trim(), fields.description, fields.promptPrefix.trim(),
                    fields.emoji, editing.base?.revision ?: 0,
                    editing.base?.targets ?: listOfNotNull(target?.let { RoleSettingTarget(it.machineId, it.id, it.machineName, it.name, "configured") }))
                tasks.launch { if (state.perform(RoleSettingsAction.Save(editing.id, editing.base, fields, target), editing.id, preview)) draft = null }
            },
            onDelete = { base -> tasks.launch { if (state.perform(RoleSettingsAction.Delete(base), base.id, null)) draft = null } })
        return
    }
    Scaffold(containerColor = LodyTheme.colors.bgBase, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(LodyIcons.Back, stringResource(R.string.settings_agent_back)) }
            Text(stringResource(R.string.settings_roles), Modifier.weight(1f), style = LodyTheme.typography.headline, color = LodyTheme.colors.textPrimary)
            IconButton(onClick = { draft = RoleDraft(null) }, enabled = state != null && state.live && state.snapshot?.agents?.isNotEmpty() == true) {
                Icon(LodyIcons.Plus, stringResource(R.string.roles_add))
            }
        }
    }) { padding ->
        val roles = state?.snapshot?.roles.orEmpty()
        LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
            if (state?.busy == true) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (state?.error != null) item { RoleNotice(roleError(state.error)) }
            if (state?.snapshot != null && roles.isEmpty()) item { RoleNotice(stringResource(R.string.roles_empty)) }
            val mine = roles.filter { it.ownerUserId == home.userId }
            val others = roles.filter { it.ownerUserId != home.userId }
            if (mine.isNotEmpty()) item { SettingsHeading(stringResource(R.string.roles_mine)) }
            items(mine, key = { "mine-${it.id}" }) { role -> RoleLine(role, mine = true) { draft = RoleDraft(role) } }
            if (others.isNotEmpty()) item { SettingsHeading(stringResource(R.string.roles_shared_by_others)) }
            items(others, key = { "other-${it.id}" }) { role -> RoleLine(role, mine = false) { draft = RoleDraft(role) } }
            if (roles.isNotEmpty()) item { RoleNotice(stringResource(R.string.roles_hint)) }
        }
    }
}

@Composable
private fun RoleLine(role: RoleSetting, mine: Boolean, onClick: () -> Unit) {
    val target = role.targets.firstOrNull()
    val unavailable = role.targets.firstOrNull { it.state != "configured" }
    val summary = role.description.trim().ifEmpty { target?.let { "${it.agentName} · ${it.machineName}" }.orEmpty() }
    val line = listOfNotNull(unavailable?.let { roleState(it.state) }, summary.ifEmpty { null }).joinToString(" · ")
    SettingsLine(role.name, LodyIcons.User, line, onClick = onClick, leading = { EmojiBadge(role.emoji, LodySize.avatarMd) }, trailing = {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
            if (mine) Text(stringResource(if (role.shared) R.string.roles_shared else R.string.roles_private), style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary)
            Icon(LodyIcons.Forward, null, Modifier.size(LodyIconSize.sm), tint = LodyTheme.colors.textSecondary)
        }
    })
}

@Composable
private fun EmojiBadge(emoji: String, size: androidx.compose.ui.unit.Dp) {
    Box(Modifier.size(size).background(LodyTheme.colors.bgSunken, CircleShape), contentAlignment = Alignment.Center) {
        Text(emoji, fontSize = (size.value * 0.5f).sp)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoleEditor(
    base: RoleSetting?, userId: String, agents: List<RoleAgent>, busy: Boolean, error: String?,
    onBack: () -> Unit, onSave: (RoleFields, RoleAgent?) -> Unit, onDelete: (RoleSetting) -> Unit,
) {
    val readOnly = base != null && base.ownerUserId != userId
    var name by remember(base?.id) { mutableStateOf(base?.name.orEmpty()) }
    var description by remember(base?.id) { mutableStateOf(base?.description.orEmpty()) }
    var prompt by remember(base?.id) { mutableStateOf(base?.promptPrefix.orEmpty()) }
    var shared by remember(base?.id) { mutableStateOf(base?.shared == true) }
    var emoji by remember(base?.id) { mutableStateOf(base?.emoji ?: "🪼") }
    var target by remember(base?.id) { mutableStateOf(agents.firstOrNull()) }
    var picker by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    val editable = !readOnly && !busy
    val valid = name.isNotBlank() && name.trim().length <= 60 && description.length <= 140 && (base != null || target != null)
    Scaffold(containerColor = LodyTheme.colors.bgBase, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(LodyIcons.Close, stringResource(R.string.settings_agent_cancel)) }
            Text(stringResource(if (base == null) R.string.roles_add else R.string.roles_edit), Modifier.weight(1f), style = LodyTheme.typography.headline, color = LodyTheme.colors.textPrimary)
            if (!readOnly) IconButton(onClick = { onSave(RoleFields(name, description, prompt, shared, emoji), target) }, enabled = editable && valid) {
                Icon(LodyIcons.Check, stringResource(R.string.settings_agent_save))
            }
        }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).imePadding()) {
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            Column(Modifier.fillMaxWidth().padding(vertical = LodySpacing.lg), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.size(88.dp).background(LodyTheme.colors.bgSunken, CircleShape).clickable(enabled = editable) { picker = "emoji" },
                    contentAlignment = Alignment.Center) { Text(emoji, fontSize = 44.sp) }
                if (editable) Text(stringResource(R.string.roles_emoji_hint), Modifier.padding(top = LodySpacing.sm), style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary)
            }
            if (readOnly) RoleNotice(stringResource(R.string.roles_read_only), center = true)
            if (error != null) RoleNotice(roleError(error), danger = true)
            Column(Modifier.padding(horizontal = LodySpacing.lg), verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
                OutlinedTextField(name, { if (it.length <= 60) name = it }, Modifier.fillMaxWidth(), enabled = editable, singleLine = true,
                    label = { Text(stringResource(R.string.roles_name)) })
                OutlinedTextField(description, { if (it.length <= 140) description = it }, Modifier.fillMaxWidth(), enabled = editable,
                    label = { Text(stringResource(R.string.roles_description)) })
            }
            SettingsGroup(stringResource(R.string.roles_target)) {
                if (base == null) {
                    // New chat's order: the computer first, then one of its Agent configs.
                    SettingsLine(target?.machineName ?: stringResource(R.string.create_pick_machine), LodyIcons.Machine,
                        onClick = { picker = "machine" }.takeIf { editable })
                    SettingsLine(target?.name ?: stringResource(R.string.roles_agent), LodyIcons.Agent, onClick = { picker = "target" }.takeIf { editable && target != null },
                        leading = { AgentMark(target?.cliType ?: "builtin", target?.agentType ?: "", LodyTheme.colors.textPrimary, Modifier.size(LodyIconSize.lg)) })
                } else base.targets.forEach { item ->
                    SettingsLine(item.agentName, LodyIcons.Machine, if (item.state == "configured") item.machineName else "${item.machineName} · ${roleState(item.state)}")
                }
            }
            SettingsGroup {
                SettingsLine(stringResource(R.string.roles_workspace), LodyIcons.Share, stringResource(R.string.roles_visibility_hint), trailing = {
                    Switch(shared, { shared = it }, enabled = editable)
                })
            }
            SettingsGroup(stringResource(R.string.roles_prompt)) {
                OutlinedTextField(prompt, { if (it.length <= 32000) prompt = it }, Modifier.fillMaxWidth().heightIn(min = 180.dp).padding(horizontal = LodySpacing.sm),
                    enabled = editable, placeholder = { Text(stringResource(R.string.roles_prompt_hint)) })
            }
            if (base != null && !readOnly) SettingsGroup {
                TextButton(onClick = { confirmDelete = true }, enabled = editable, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.roles_delete), color = LodyTheme.colors.dangerDefault)
                }
            }
            Spacer(Modifier.height(LodySpacing.xxl))
        }
    }
    when (picker) {
        "emoji" -> ModalBottomSheet(onDismissRequest = { picker = null }, containerColor = LodyTheme.colors.bgBase) {
            LazyVerticalGrid(GridCells.Fixed(6), Modifier.fillMaxWidth().padding(horizontal = LodySpacing.lg)) {
                items(RoleEmojis) { glyph ->
                    Box(Modifier.aspectRatio(1f).padding(LodySpacing.xs)
                        .background(if (glyph == emoji) LodyTheme.colors.bgSunken else LodyTheme.colors.bgBase, RoundedCornerShape(LodyRadius.md))
                        .clickable { emoji = glyph; picker = null }, contentAlignment = Alignment.Center) { Text(glyph, fontSize = 28.sp) }
                }
            }
            Spacer(Modifier.height(LodySpacing.xxl))
        }
        "machine" -> ModalBottomSheet(onDismissRequest = { picker = null }, containerColor = LodyTheme.colors.bgBase) {
            LazyColumn {
                item { SettingsHeading(stringResource(R.string.create_pick_machine)) }
                // Computers that offer at least one Agent config, in the listing's order.
                items(agents.distinctBy { it.machineId }, key = { it.machineId }) { first ->
                    SettingsLine(first.machineName, LodyIcons.Machine, onClick = {
                        if (first.machineId != target?.machineId) target = first
                        picker = null
                    }, trailing = { if (first.machineId == target?.machineId) Icon(LodyIcons.Check, null, tint = LodyTheme.colors.accentFg) })
                }
            }
            Spacer(Modifier.height(LodySpacing.xxl))
        }
        "target" -> ModalBottomSheet(onDismissRequest = { picker = null }, containerColor = LodyTheme.colors.bgBase) {
            LazyColumn {
                item { SettingsHeading(target?.machineName.orEmpty()) }
                items(agents.filter { it.machineId == target?.machineId }, key = { "${it.machineId}:${it.id}" }) { agent ->
                    SettingsLine(agent.name, LodyIcons.Agent, onClick = { target = agent; picker = null },
                        leading = { AgentMark(agent.cliType ?: "builtin", agent.agentType ?: "", LodyTheme.colors.textPrimary, Modifier.size(LodyIconSize.lg)) },
                        trailing = { if (agent == target) Icon(LodyIcons.Check, null, tint = LodyTheme.colors.accentFg) })
                }
            }
            Spacer(Modifier.height(LodySpacing.xxl))
        }
    }
    if (confirmDelete && base != null) AlertDialog(onDismissRequest = { confirmDelete = false },
        title = { Text(stringResource(R.string.roles_delete)) },
        text = { Text(stringResource(R.string.roles_delete_hint, base.name)) },
        confirmButton = { TextButton(onClick = { confirmDelete = false; onDelete(base) }) { Text(stringResource(R.string.settings_agent_delete), color = LodyTheme.colors.dangerDefault) } },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.settings_agent_cancel)) } })
}

private val RoleEmojis = listOf(
    "🪼", "🤖", "🧠", "🛠️", "🔍", "🧪", "📝", "🎨", "🚀", "🐛", "🔒", "📦",
    "🧭", "📊", "💡", "⚙️", "🧹", "🔧", "🧩", "📚", "🗂️", "🌐", "📱", "🖥️",
    "☁️", "🗄️", "🔥", "✅", "🎯", "🧑‍💻", "👀", "✍️", "🦉", "🐙", "🦊", "🐝",
)

@Composable
private fun RoleNotice(text: String, center: Boolean = false, danger: Boolean = false) {
    Text(text, Modifier.fillMaxWidth().padding(horizontal = LodySpacing.xxl, vertical = LodySpacing.md), style = LodyTheme.typography.footnote,
        color = if (danger) LodyTheme.colors.dangerDefault else LodyTheme.colors.textSecondary, textAlign = if (center) TextAlign.Center else TextAlign.Start)
}

@Composable
private fun roleState(state: String): String = stringResource(when (state) {
    "machineUnavailable" -> R.string.roles_machine_unavailable
    "agentUnavailable" -> R.string.roles_agent_unavailable
    else -> R.string.roles_agent_unavailable
})

@Composable
private fun roleError(code: String?): String = stringResource(when (code) {
    "role_load_failed" -> R.string.roles_load_failed
    "role_read_only" -> R.string.roles_read_only
    "role_conflict" -> R.string.settings_agent_conflict
    "role_duplicate" -> R.string.roles_duplicate
    "role_forbidden" -> R.string.roles_access_denied
    "role_target_unavailable" -> R.string.roles_target_unavailable
    "role_invalid" -> R.string.roles_invalid
    else -> R.string.roles_unknown
})
