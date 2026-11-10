package app.lody.android.runtime

import org.json.JSONArray
import org.json.JSONObject

internal object CreationJson {
    private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }
    private fun choices(array: JSONArray?) = array.objects().map { CreationChoice(it.getString("id"), it.getString("name")) }
    fun options(value: JSONObject): CreationOptions = CreationOptions(
        value.optJSONArray("agents").objects().map { CreationAgent(it.getString("id"), it.getString("name"), it.getString("machineId"), it.getString("cliType"), it.getString("agentType")) },
        value.optJSONArray("capabilities").objects().map { c ->
            val config = c.optJSONArray("configOptions").objects()
            val defaultModel = config.firstOrNull { it.optString("category") == "model" }?.optString("currentValue")?.takeIf { it.isNotBlank() }
            val thought = config.firstOrNull { it.optString("type") == "select" && (it.optString("category") == "thought_level" || it.optString("id") == "reasoning_effort") }
            val defaultEfforts = choices(thought?.optJSONArray("options")).map { it.id }
            val efforts = c.optJSONObject("reasoningEfforts") ?: JSONObject()
            CreationCapability(c.getString("machineId"), c.getString("cliType"), c.getString("agentType"), choices(c.optJSONArray("models")), choices(c.optJSONArray("modes")), efforts.keys().asSequence().associateWith { key ->
                val a = efforts.getJSONArray(key); (0 until a.length()).map { a.getString(it) }
            }, c.optString("agentConfigId").takeIf { it.isNotBlank() }, defaultModel, defaultEfforts, switches(config), c.optJSONObject("fastModes")?.let { modes -> modes.keys().asSequence().associateWith { modes.getBoolean(it) } }.orEmpty(), c.optBoolean("steer"))
        },
        value.optString("availability", "unknown"),
        value.optJSONArray("onlineMachineIds")?.let { ids -> (0 until ids.length()).map { ids.getString(it) }.toSet() },
    )
    /** Plan and Fast candidates: boolean options and collaboration-mode selects (with their value ids). */
    private fun switches(config: List<JSONObject>) = config.mapNotNull { option ->
        val type = option.optString("type")
        val collaboration = option.optString("id") == "collaboration_mode" || option.optString("category") == "collaboration_mode"
        if (type != "boolean" && !(type == "select" && collaboration)) return@mapNotNull null
        val current = option.opt("currentValue").takeIf { it is String || it is Boolean }
        CreationConfigOption(option.getString("id"), option.optString("category").ifBlank { null }, type, current, choicesIds(option.optJSONArray("options")))
    }
    private fun choicesIds(array: JSONArray?) = array.objects().mapNotNull { it.optString("id").ifBlank { null } }

    fun encodeOptions(value: CreationOptions) = JSONObject().apply {
        put("availability", value.availability)
        fun choices(values: List<CreationChoice>) = JSONArray(values.map { JSONObject().put("id", it.id).put("name", it.name) })
        put("agents", JSONArray(value.agents.map { JSONObject().put("id", it.id).put("name", it.name).put("machineId", it.machineId).put("cliType", it.cliType).put("agentType", it.agentType) }))
        put("capabilities", JSONArray(value.capabilities.map { c -> JSONObject().put("machineId", c.machineId).put("cliType", c.cliType).put("agentType", c.agentType).put("agentConfigId", c.agentConfigId)
            .put("configOptions", JSONArray().apply {
                c.defaultModelId?.let { put(JSONObject().put("id", "model").put("category", "model").put("currentValue", it)) }
                put(JSONObject().put("id", "reasoning_effort").put("type", "select").put("category", "thought_level").put("options", choices(c.defaultEfforts.map { CreationChoice(it, it) })))
                c.switches.forEach { option ->
                    put(JSONObject().put("id", option.id).put("type", option.type).apply {
                        option.category?.let { put("category", it) }
                        option.currentValue?.let { put("currentValue", it) }
                    }.put("options", choices(option.options.map { CreationChoice(it, it) })))
                }
            })
            .put("fastModes", JSONObject(c.fastModes))
            .put("models", choices(c.models)).put("modes", choices(c.modes)).put("reasoningEfforts", JSONObject().apply { c.efforts.forEach { (model, levels) -> put(model, JSONArray(levels)) } }) }))
    }
    fun request(value: CreateRequest) = JSONObject().apply {
        if (value.attachments.isNotEmpty()) put("attachments", JSONArray(value.attachments))
        put("sessionId", value.sessionId); put("turnId", value.turnId); put("projectId", value.projectId)
        put("machineId", value.machineId); put("agentConfigId", value.agentConfigId); put("text", value.text)
        put("branch", value.branch); put("worktree", value.worktree); put("modelId", value.modelId); put("modeId", value.modeId); put("effort", value.effort)
        value.agentRoleId?.let { put("agentRoleId", it) }
        if (value.configOptionValues.isNotEmpty()) put("configOptionValues", JSONObject(value.configOptionValues))
    }

    /** Runtime `agentRoles` list: only string / boolean pinned values are kept. */
    fun roles(value: JSONObject): List<AgentRole> = value.optJSONArray("roles").objects().map { role ->
        AgentRole(
            role.getString("id"), role.getString("name"),
            role.optString("emoji").ifBlank { "🪼" }, role.optInt("revision", 1),
            role.optJSONArray("targets").objects().map { target ->
                val run = target.optJSONObject("runConfig")
                val options = run?.optJSONObject("configOptionValues")?.let { values ->
                    values.keys().asSequence().mapNotNull { key -> (values.get(key) as? String ?: values.get(key) as? Boolean)?.let { key to it } }.toMap()
                }.orEmpty()
                AgentRoleTarget(
                    target.getString("machineId"), target.getString("agentConfigId"), target.optString("state", "configured"),
                    RoleRunConfig(run?.optString("modelId")?.ifBlank { null }, run?.optString("modeId")?.ifBlank { null }, options),
                )
            },
        )
    }
}
