package app.lody.android.chat

import app.lody.android.create.CreateSessionModel
import app.lody.android.runtime.AgentRole
import app.lody.android.runtime.CreationAgent
import app.lody.android.runtime.CreationCapability
import app.lody.android.runtime.RoleSend
import app.lody.android.runtime.RunChoice

/**
 * Agent Roles in an existing conversation, after web's session composer
 * (`selectSessionAgentRoles`, `use-session-agent-role.ts`); iOS `SessionRoles`. The agent never
 * changes here: a Role is offered only when it binds the conversation's own computer AND Agent
 * Config, picking one applies just the values it pins, and a turn runs as it only while those
 * values still hold.
 */
object SessionRoles {
    /** A Role choice: an explicit None, or a Role by id. */
    sealed interface Pick {
        data object None : Pick
        data class Role(val id: String) : Pick
    }

    /** The composer's run config: model, effort, mode and other agent options. */
    data class Choice(val modelId: String?, val effort: String?, val modeId: String?, val options: Map<String, Any>)

    /** Roles bound to the conversation's computer and Agent Config, by name; unavailable ones keep their reason. */
    fun items(roles: List<AgentRole>, machineId: String, agentConfigId: String?, onlineAgents: List<CreationAgent>): List<CreateSessionModel.RoleItem> {
        if (agentConfigId.isNullOrEmpty() || machineId.isEmpty()) return emptyList()
        return CreateSessionModel.roleItems(roles, machineId, onlineAgents).filter { it.target.agentConfigId == agentConfigId }
    }

    /** The latest turn's Role from the runtime composer projection; null when it says nothing. */
    fun durable(choice: RunChoice?): Pick? = when {
        choice == null || !choice.roleKnown -> null
        choice.agentRoleId == null -> Pick.None
        else -> Pick.Role(choice.agentRoleId)
    }

    /**
     * The Role the composer IS: the one picked here (an explicit None wins), else the one the
     * latest turn ran as, while it can run and every value it pins is what will run.
     */
    fun active(items: List<CreateSessionModel.RoleItem>, picked: Pick?, durable: Pick?, agentConfigId: String?, choice: Choice): CreateSessionModel.RoleItem? {
        val id = ((picked ?: durable) as? Pick.Role)?.id ?: return null
        val item = items.firstOrNull { it.role.id == id } ?: return null
        return item.takeIf { CreateSessionModel.roleApplied(it, agentConfigId, choice.modelId, choice.modeId, choice.effort) }
    }

    /** Picking a Role sets the values it pins that this agent offers; everything else stays the conversation's own. */
    fun apply(item: CreateSessionModel.RoleItem, current: Choice, capability: CreationCapability?): Choice {
        val pinned = CreateSessionModel.roleChoice(item.target)
        var next = current
        val model = pinned.modelId
        if (model != null && (capability == null || capability.models.any { it.id == model })) {
            next = next.copy(modelId = model, effort = if (model != current.modelId && pinned.effort == null) null else next.effort)
        }
        val mode = pinned.modeId
        if (mode != null && (capability == null || capability.modes.any { it.id == mode })) next = next.copy(modeId = mode)
        pinned.effort?.let { next = next.copy(effort = it) }
        if (pinned.options.isNotEmpty()) next = next.copy(options = next.options + pinned.options)
        return next
    }

    /** What the next turn carries. Until the Role list has loaded nothing is claimed either way. */
    fun send(loaded: Boolean, active: CreateSessionModel.RoleItem?, picked: Pick?, durable: Pick?): RoleSend {
        if (active != null) return RoleSend.Role(active.role.id)
        if (!loaded) return RoleSend.Inherit
        return if ((picked ?: durable) != null) RoleSend.None else RoleSend.Inherit
    }
}
