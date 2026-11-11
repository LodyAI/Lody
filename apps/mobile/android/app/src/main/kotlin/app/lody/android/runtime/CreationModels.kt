package app.lody.android.runtime

data class CreationChoice(val id: String, val name: String)
data class CreationAgent(val id: String, val name: String, val machineId: String, val cliType: String, val agentType: String)
/** An agent switch the composer may offer (ACP config option); [options] are a select's value ids. */
data class CreationConfigOption(val id: String, val category: String?, val type: String, val currentValue: Any?, val options: List<String> = emptyList())
data class CreationCapability(val machineId: String, val cliType: String, val agentType: String, val models: List<CreationChoice>, val modes: List<CreationChoice>, val efforts: Map<String, List<String>>, val agentConfigId: String? = null, val defaultModelId: String? = null, val defaultEfforts: List<String> = emptyList(), val switches: List<CreationConfigOption> = emptyList(), val fastModes: Map<String, Boolean> = emptyMap(), val steer: Boolean = false) {
    fun effortsFor(modelId: String?): List<String> = efforts[modelId ?: defaultModelId] ?: defaultEfforts

    /** Web's Plan switch: Lody's boolean `plan_mode`, or a collaboration mode with a `plan` value. */
    val planSwitch: CreationConfigOption? get() = switches.firstOrNull {
        (it.id == "plan_mode" && it.type == "boolean") ||
            ((it.id == "collaboration_mode" || it.category == "collaboration_mode") && it.type == "select" && "plan" in it.options)
    }

    /** Web's Fast switch: a boolean `fast-mode` / `fast` option. */
    val fastSwitch: CreationConfigOption? get() = switches.firstOrNull { it.id in setOf("fast-mode", "fast") && it.type == "boolean" }

    /** Whether [option] is on given the chosen values (else the agent's current value). */
    fun switchOn(option: CreationConfigOption, values: Map<String, Any>): Boolean {
        val value = values[option.id] ?: option.currentValue
        return value == true || value == "plan"
    }

    /** The value that turns [option] on or off (`plan` / `default` for a collaboration mode). */
    fun switchValue(option: CreationConfigOption, on: Boolean): Any = if (option.type == "boolean") on else if (on) "plan" else "default"

    /** Plan / Fast state for the chip and sheet; null when the agent offers no such switch. */
    fun planOn(values: Map<String, Any>): Boolean? = planSwitch?.let { switchOn(it, values) }
    fun fastOn(values: Map<String, Any>, modelId: String? = null): Boolean? = fastSwitch?.takeUnless { fastModes[modelId ?: defaultModelId] == false }?.let { switchOn(it, values) }

    /** The option id and value that set Plan / Fast; null when not offered. */
    fun planValue(on: Boolean): Pair<String, Any>? = planSwitch?.let { it.id to switchValue(it, on) }
    fun fastValue(on: Boolean, modelId: String? = null): Pair<String, Any>? = fastSwitch?.takeUnless { fastModes[modelId ?: defaultModelId] == false }?.let { it.id to switchValue(it, on) }
}
data class CreationOptions(val agents: List<CreationAgent>, val capabilities: List<CreationCapability>, val availability: String = "online", val onlineMachineIds: Set<String>? = null) {
    fun capability(agent: CreationAgent?): CreationCapability? {
        if (agent == null) return null
        return capabilities.firstOrNull { it.machineId == agent.machineId && it.agentConfigId == agent.id }
            ?: capabilities.firstOrNull { it.machineId == agent.machineId && it.agentConfigId == null && it.cliType == agent.cliType && it.agentType == agent.agentType }
    }

    /**
     * A running session's provider choices: the capability probed for its own Agent Config, as
     * web; sessions or runtimes without one fall back to the computer's agent type.
     */
    fun capability(machineId: String, cliType: String?, agentType: String?, agentConfigId: String? = null): CreationCapability? {
        if (agentConfigId != null) capabilities.firstOrNull { it.machineId == machineId && it.agentConfigId == agentConfigId }?.let { return it }
        val matching = capabilities.filter { it.machineId == machineId && it.cliType == cliType && it.agentType == agentType }
        return matching.firstOrNull { it.agentConfigId == null } ?: matching.firstOrNull()
    }
}
data class CreateRequest(
    val sessionId: String, val turnId: String, val projectId: String?, val machineId: String, val agentConfigId: String, val text: String,
    val branch: String?, val worktree: Boolean, val modelId: String?, val modeId: String?, val effort: String?,
    /** The Agent Role the session starts as; the runtime re-reads it and applies it or refuses. */
    val agentRoleId: String? = null,
    /** Option values the Role pins beyond model / mode / effort (strings or booleans). */
    val configOptionValues: Map<String, Any> = emptyMap(),
    val attachments: List<org.json.JSONObject> = emptyList(),
)

/** What one machine target of an Agent Role pins (runtime listing; secrets never cross). */
data class RoleRunConfig(val modelId: String? = null, val modeId: String? = null, val options: Map<String, Any> = emptyMap())
data class AgentRoleTarget(val machineId: String, val agentConfigId: String, val state: String, val runConfig: RoleRunConfig = RoleRunConfig())
/** A workspace Agent Role readable by this user (web `AgentRole`); [emoji] defaults like web's. */
data class AgentRole(val id: String, val name: String, val emoji: String, val revision: Int, val targets: List<AgentRoleTarget>)
/** A new chat's run configuration on one computer: its agent and model / mode / reasoning. */
data class RunSelection(val agentId: String, val modelId: String? = null, val modeId: String? = null, val effort: String? = null)
/**
 * One whole configuration a chat was started with (web `RecentRunConfigRecord`). A Role is not
 * interchangeable with the values it set, so [agentRoleId] is part of its identity.
 */
data class RecentRunConfig(val machineId: String, val selection: RunSelection, val agentRoleId: String? = null, val usedAt: Long = 0)
/** Device-local, per account + workspace: the last selection on each computer and recent configurations, newest first. */
data class RunConfigPrefs(val machines: Map<String, RunSelection> = emptyMap(), val recents: List<RecentRunConfig> = emptyList())
data class CreationReceipt(val sessionId: String, val state: String)
