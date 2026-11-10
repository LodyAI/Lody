package app.lody.android.runtime

import org.json.JSONArray
import org.json.JSONObject

/** The Agent Roles settings page's projection of runtime `agentRoles` (iOS `AgentRoleSnapshot`). */
data class RoleSettingsSnapshot(val roles: List<RoleSetting>, val agents: List<RoleAgent>)
data class RoleSetting(
    val id: String, val ownerUserId: String, val shared: Boolean, val name: String, val description: String,
    val promptPrefix: String, val emoji: String, val revision: Int, val targets: List<RoleSettingTarget>,
    /** The listed row exactly as read; a save or delete sends it back as its base. */
    internal val raw: String = "",
)
data class RoleSettingTarget(val machineId: String, val agentConfigId: String, val machineName: String, val agentName: String, val state: String)
data class RoleAgent(val id: String, val name: String, val machineId: String, val machineName: String, val cliType: String?, val agentType: String?)
data class RoleFields(val name: String, val description: String, val promptPrefix: String, val shared: Boolean, val emoji: String)

sealed interface RoleSettingsAction {
    data object List : RoleSettingsAction
    data class Save(val id: String, val base: RoleSetting?, val fields: RoleFields, val target: RoleAgent?) : RoleSettingsAction
    data class Delete(val base: RoleSetting) : RoleSettingsAction
}

internal object RoleSettingsJson {
    private fun JSONObject.rows(key: String): kotlin.collections.List<JSONObject> = optJSONArray(key)?.let { rows -> (0 until rows.length()).map { rows.getJSONObject(it) } }.orEmpty()
    private fun JSONObject.text(key: String): String? = (opt(key) as? String)?.takeIf { it.isNotBlank() }

    fun result(value: JSONObject): RoleSettingsSnapshot {
        if (value.has("error")) throw RuntimeException(RuntimeFault(value.getString("error"), RuntimeErrorCategory.BUSINESS))
        return RoleSettingsSnapshot(
            value.rows("roles").map { role ->
                RoleSetting(
                    role.getString("id"), role.getString("ownerUserId"), role.optString("visibility") == "workspace",
                    role.optString("name"), role.optString("description"), role.optString("promptPrefix"),
                    role.text("emoji") ?: "🪼", role.optInt("revision", 1),
                    role.rows("targets").map { RoleSettingTarget(it.getString("machineId"), it.getString("agentConfigId"), it.optString("machineName"), it.optString("agentName"), it.optString("state", "configured")) },
                    role.toString(),
                )
            },
            value.rows("agents").map { RoleAgent(it.getString("id"), it.optString("name"), it.getString("machineId"), it.optString("machineName"), it.text("cliType"), it.text("agentType")) },
        )
    }

    fun request(action: RoleSettingsAction): JSONObject = JSONObject().apply {
        when (action) {
            RoleSettingsAction.List -> put("action", "list")
            is RoleSettingsAction.Save -> {
                put("action", "save"); put("id", action.id)
                put("base", action.base?.let { JSONObject(it.raw) } ?: JSONObject.NULL)
                put("fields", JSONObject().put("name", action.fields.name).put("description", action.fields.description)
                    .put("promptPrefix", action.fields.promptPrefix).put("visibility", if (action.fields.shared) "workspace" else "private")
                    .put("emoji", action.fields.emoji))
                action.target?.let { put("target", JSONObject().put("machineId", it.machineId).put("agentConfigId", it.id)) }
            }
            is RoleSettingsAction.Delete -> { put("action", "delete"); put("base", JSONObject(action.base.raw)) }
        }
    }
}
