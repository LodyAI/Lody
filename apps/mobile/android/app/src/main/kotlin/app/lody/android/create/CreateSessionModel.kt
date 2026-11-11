package app.lody.android.create

import app.lody.android.runtime.CatalogProject
import app.lody.android.runtime.CatalogSnapshot
import app.lody.android.runtime.AgentRole
import app.lody.android.runtime.AgentRoleTarget
import app.lody.android.runtime.CreationAgent
import app.lody.android.runtime.CreationCapability
import app.lody.android.runtime.RecentRunConfig
import app.lody.android.runtime.RunConfigPrefs
import app.lody.android.runtime.RunSelection

/**
 * Where a new session would run; iOS counterpart: `CreateSessionForm` + `CreateSessionContext`.
 * A local project fixes its computer; a GitHub project or a plain chat may pick any computer.
 */
data class CreateTarget(
    val chat: Boolean = false,
    val projectId: String? = null,
    val machineId: String? = null,
    /** Local projects only: start in a new git worktree. GitHub sessions always do. */
    val worktree: Boolean = false,
)

object CreateSessionModel {
    /** Only resolve the initial automatic choice; never move an explicit choice or a local project. */
    fun withInitialAvailability(target: CreateTarget, options: app.lody.android.runtime.CreationOptions, explicitlySelected: Boolean = false): CreateTarget {
        if (explicitlySelected || (!target.chat && !isGithub(target.projectId))) return target
        if (options.agents.any { it.machineId == target.machineId }) return target
        return options.agents.firstOrNull()?.let { target.copy(machineId = it.machineId) } ?: target
    }

    fun isGithub(projectId: String?) = projectId?.startsWith("github:") == true
    /** A multi-repository project (web Project group); its `machineId` is empty when it runs anywhere. */
    fun isGroup(projectId: String?) = projectId?.startsWith(GROUP_PREFIX) == true
    const val GROUP_PREFIX = "group:"
    fun isChat(projectId: String) = projectId.endsWith(":unassigned")

    /** Computers by id with their display name (the id when the catalog has none). */
    fun machines(snapshot: CatalogSnapshot, onlineMachineIds: Set<String>? = null): List<Pair<String, String>> =
        snapshot.machineIds.distinct().sortedBy { onlineMachineIds != null && it !in onlineMachineIds }.map { it to (snapshot.machineNames[it] ?: it) }

    /** Projects, most recently active first (matching Home's by-project order). */
    fun projects(snapshot: CatalogSnapshot): List<CatalogProject> {
        val latest = snapshot.sessions.groupBy { it.projectId }.mapValues { (_, sessions) ->
            sessions.maxOf { it.lastMessageAt ?: 0L }
        }
        return snapshot.projects.filterNot { isChat(it.id) }.sortedByDescending { latest[it.id] ?: 0L }
    }

    fun initial(snapshot: CatalogSnapshot, projectId: String? = null): CreateTarget {
        val project = projects(snapshot).firstOrNull { it.id == projectId } ?: projects(snapshot).firstOrNull()
        return if (project == null) CreateTarget(chat = true, machineId = machines(snapshot).firstOrNull()?.first)
        else select(snapshot, CreateTarget(), project.id)
    }

    /** Picks a project, keeping a chosen computer where the project allows any. */
    fun select(snapshot: CatalogSnapshot, target: CreateTarget, projectId: String): CreateTarget {
        val project = snapshot.projects.firstOrNull { it.id == projectId } ?: return target
        val machine = when {
            isGithub(project.id) -> target.machineId ?: machines(snapshot).firstOrNull()?.first
            // A group runs on its local members' computer, or on any when it has none.
            isGroup(project.id) -> project.machineId.ifEmpty { null } ?: target.machineId ?: machines(snapshot).firstOrNull()?.first
            else -> project.machineId
        }
        return CreateTarget(chat = false, projectId = project.id, machineId = machine, worktree = target.worktree && !isGithub(project.id) && !isGroup(project.id))
    }

    fun chat(snapshot: CatalogSnapshot, target: CreateTarget): CreateTarget =
        CreateTarget(chat = true, machineId = target.machineId ?: machines(snapshot).firstOrNull()?.first)

    /** Every known computer is offered whenever there is more than one (web's machine menu). */
    fun machineChoosable(snapshot: CatalogSnapshot): Boolean = machines(snapshot).size > 1

    /**
     * A local project belongs to one computer: picking another moves to that computer's most
     * recent local project, or to a chat there when it has none. Chats and GitHub projects switch.
     */
    fun pickMachine(snapshot: CatalogSnapshot, target: CreateTarget, machineId: String): CreateTarget {
        if (!target.chat && isGroup(target.projectId)) {
            // A group pinned to another computer cannot run there: back to a chat on it.
            val pinned = snapshot.projects.firstOrNull { it.id == target.projectId }?.machineId.orEmpty()
            return if (pinned.isEmpty() || pinned == machineId) target.copy(machineId = machineId) else CreateTarget(chat = true, machineId = machineId)
        }
        val local = !target.chat && target.projectId != null && !isGithub(target.projectId)
        if (!local) return target.copy(machineId = machineId)
        val current = snapshot.projects.firstOrNull { it.id == target.projectId }
        if (current?.machineId == machineId) return target
        val next = projects(snapshot).firstOrNull { it.machineId == machineId && !isGithub(it.id) }
        return if (next != null) select(snapshot, target, next.id) else CreateTarget(chat = true, machineId = machineId)
    }

    const val RECENT_LIMIT = 5

    /** GitHub projects and groups without local members run on any computer. */
    fun isUsable(project: CatalogProject, target: CreateTarget): Boolean =
        isGithub(project.id) || target.machineId == null || project.machineId == target.machineId ||
            (isGroup(project.id) && project.machineId.isEmpty())

    /**
     * The project menu's recent part: the five most recent projects usable on the chosen
     * computer (its local projects and any GitHub project); a selected project outside them
     * still shows so the check matches the line.
     */
    fun recent(snapshot: CatalogSnapshot, target: CreateTarget): List<CatalogProject> {
        val usable = projects(snapshot).filter { isUsable(it, target) }
        val recent = usable.take(RECENT_LIMIT)
        val current = usable.firstOrNull { it.id == target.projectId && !target.chat }
        return if (current == null || recent.any { it.id == current.id }) recent else listOf(current) + recent
    }

    /** The computer's icon kind, by OS and (for Macs) name; iOS `CreateSessionContext.machineGlyph`. */
    enum class MachineKind { Laptop, Desktop, Server }

    fun machineKind(snapshot: CatalogSnapshot, id: String?): MachineKind {
        if (id == null) return MachineKind.Laptop
        val name = snapshot.machineNames[id].orEmpty().lowercase()
        return when (snapshot.machineOs[id]) {
            "darwin" -> if (listOf("imac", "mini", "studio", "mac pro").any { it in name }) MachineKind.Desktop else MachineKind.Laptop
            "win32" -> MachineKind.Desktop
            "linux" -> MachineKind.Server
            else -> MachineKind.Laptop
        }
    }

    // ── Last selection per computer and recently used configurations (web `lib/recent-run-configs.ts`) ──

    /** Stored deeper than shown, so one one-off run cannot evict a combination used every day. */
    const val MAX_STORED_RECENTS = 12
    const val MAX_VISIBLE_RECENTS = 3

    /** Two runs are the same configuration only when every value matches. */
    fun recentKey(machineId: String, selection: RunSelection, agentRoleId: String?): String =
        listOf(machineId, selection.agentId, selection.modelId.orEmpty(), selection.modeId.orEmpty(), selection.effort.orEmpty(), agentRoleId.orEmpty())
            .joinToString("\u0000")

    fun recentKey(record: RecentRunConfig) = recentKey(record.machineId, record.selection, record.agentRoleId)

    /** Records a started chat: its computer's last selection, and the newest recent entry (deduplicated, capped). */
    fun started(prefs: RunConfigPrefs, machineId: String, selection: RunSelection, agentRoleId: String?, usedAt: Long): RunConfigPrefs {
        val record = RecentRunConfig(machineId, selection, agentRoleId, usedAt)
        val key = recentKey(record)
        return RunConfigPrefs(
            prefs.machines + (machineId to selection),
            (listOf(record) + prefs.recents.filter { recentKey(it) != key }).take(MAX_STORED_RECENTS),
        )
    }

    /**
     * Recent configurations offered now (web `buildRecentRunConfigItems`): on [machineId], with the
     * agent still online and a recorded Role still runnable, excluding the current one.
     */
    fun recentItems(recents: List<RecentRunConfig>, machineId: String?, onlineAgents: List<CreationAgent>, roleItems: List<RoleItem>, currentKey: String?): List<RecentRunConfig> {
        if (machineId == null) return emptyList()
        val runnableRoles = roleItems.filter { it.unavailable == null }.map { it.role.id }.toSet()
        return recents.asSequence()
            .filter { it.machineId == machineId && onlineAgents.any { agent -> agent.machineId == machineId && agent.id == it.selection.agentId } }
            .filter { it.agentRoleId == null || it.agentRoleId in runnableRoles }
            .filter { recentKey(it) != currentKey }
            .distinctBy { recentKey(it) }
            .take(MAX_VISIBLE_RECENTS)
            .toList()
    }

    /**
     * A remembered selection limited to what the agent offers now: a model, mode or reasoning
     * effort it dropped is left out rather than forced back in. Without capabilities yet, kept.
     */
    fun applicable(selection: RunSelection, capability: CreationCapability?): RunSelection {
        if (capability == null) return selection
        val modelId = selection.modelId?.takeIf { id -> capability.models.any { it.id == id } }
        return RunSelection(
            selection.agentId, modelId,
            selection.modeId?.takeIf { id -> capability.modes.any { it.id == id } },
            selection.effort?.takeIf { it in capability.effortsFor(modelId) },
        )
    }

    // ── Agent Roles (web chat landing, `composer-agent-roles.ts`) ──

    enum class RoleUnavailable { Machine, Agent, Offline }

    /** A Role offered on the selected computer: bound to that machine's target, listed even when it cannot run. */
    data class RoleItem(val role: AgentRole, val target: AgentRoleTarget, val unavailable: RoleUnavailable?)

    /** What picking a Role sets: its pinned model, mode and reasoning, and any other pinned options. */
    data class RoleChoice(val modelId: String?, val modeId: String?, val effort: String?, val options: Map<String, Any>)

    /** The reasoning option a Role pins; Android sends it as `effort` (runtime `reasoning_effort`). */
    const val EFFORT_OPTION = "reasoning_effort"

    /** Roles with a target on [machineId], by name; one whose agent is gone or offline says why. */
    fun roleItems(roles: List<AgentRole>, machineId: String?, onlineAgents: List<CreationAgent>): List<RoleItem> {
        if (machineId == null) return emptyList()
        return roles.mapNotNull { role ->
            val target = role.targets.firstOrNull { it.machineId == machineId } ?: return@mapNotNull null
            val reason = when {
                target.state == "machineUnavailable" -> RoleUnavailable.Machine
                target.state == "agentUnavailable" -> RoleUnavailable.Agent
                onlineAgents.none { it.machineId == machineId && it.id == target.agentConfigId } -> RoleUnavailable.Offline
                else -> null
            }
            RoleItem(role, target, reason)
        }.sortedWith(compareBy<RoleItem, String>(String.CASE_INSENSITIVE_ORDER) { it.role.name }.thenBy { it.role.id })
    }

    fun roleChoice(target: AgentRoleTarget): RoleChoice {
        val pinned = target.runConfig
        return RoleChoice(pinned.modelId, pinned.modeId, pinned.options[EFFORT_OPTION] as? String, pinned.options - EFFORT_OPTION)
    }

    /**
     * Web `isComposerAgentRoleApplied`: the Role names the composer only while its agent and every
     * value it pins are what will run. Its other pinned options are sent as-is, so they hold.
     */
    fun roleApplied(item: RoleItem, agentId: String?, modelId: String?, modeId: String?, effort: String?): Boolean {
        if (item.unavailable != null || agentId != item.target.agentConfigId) return false
        val pinned = item.target.runConfig
        if (pinned.modelId != null && pinned.modelId != modelId) return false
        if (pinned.modeId != null && pinned.modeId != modeId) return false
        val pinnedEffort = pinned.options[EFFORT_OPTION]
        return pinnedEffort == null || pinnedEffort == effort
    }
}
