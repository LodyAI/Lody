package app.lody.android.runtime

import org.json.JSONArray
import org.json.JSONObject

internal object AgentProviderJson {
    private fun JSONObject.rows(key: String): List<JSONObject> = getJSONArray(key).let { rows -> (0 until rows.length()).map { rows.getJSONObject(it) } }
    private fun JSONObject.strings(key: String): List<String> = optJSONArray(key)?.let { rows -> (0 until rows.length()).map { rows.getString(it) } }.orEmpty()
    fun result(value: JSONObject): AgentProviders {
        if (value.has("error")) throw RuntimeException(RuntimeFault(value.getString("error"), RuntimeErrorCategory.BUSINESS))
        return AgentProviders(
            value.rows("machines").map { ProviderMachine(it.getString("id"), it.getString("name"), it.optString("os"), it.optBoolean("readOnly", true), it.optBoolean("online"), it.optBoolean("supportsSetup"), it.optBoolean("supportsCodexProfiles"), it.optBoolean("supportsAuthentication"), it.optBoolean("supportsPiExtensions")) },
            value.rows("providers").map { AgentProvider(it.getString("id"), it.getString("machineId"), it.getString("name"), it.optString("prompt"), it.getString("cliType"), it.getString("agentType"), it.optString("command"), it.strings("args"), it.optBoolean("readOnly", true)) },
            value.rows("setups").map { ProviderSetup(it.getString("id"), it.getString("machineId"), it.getString("name"), it.getString("agentType"), it.getString("status"), it.getInt("attempt"), it.optBoolean("canRetry"), it.optBoolean("canDelete"), it.optString("failureCode").takeIf { code -> code.isNotBlank() }) },
            value.rows("catalog").map { ProviderCatalogEntry(it.getString("id"), it.getString("name"), it.getString("cliType"), it.getString("agentType")) },
            value.optBoolean("authRequired"), ProviderDetailsJson.presets(value),
        )
    }
    private fun provider(item: AgentProvider) = JSONObject().put("id", item.id).put("machineId", item.machineId)
        .put("name", item.name).put("prompt", item.prompt).put("cliType", item.cliType).put("agentType", item.agentType)
        .put("command", item.command).put("args", JSONArray(item.args)).put("readOnly", item.readOnly)
    private fun setup(item: ProviderSetup) = JSONObject().put("id", item.id).put("machineId", item.machineId).put("name", item.name)
        .put("agentType", item.agentType).put("status", item.status).put("attempt", item.attempt)
        .put("canRetry", item.canRetry).put("canDelete", item.canDelete).apply { item.failureCode?.let { put("failureCode", it) } }
    fun request(action: ProviderAction): JSONObject = JSONObject().apply {
        when (action) {
            is ProviderAction.ListMachine -> { put("action", "list"); put("machineId", action.machineId) }
            ProviderAction.List -> put("action", "list")
            is ProviderAction.Save -> {
                put("action", "save"); put("machineId", action.machineId); put("id", action.id)
                put("base", action.base?.let(::provider) ?: JSONObject.NULL)
                put("fields", JSONObject().put("name", action.fields.name.trim()).put("prompt", action.fields.prompt)
                    .put("cliType", action.fields.cliType).put("agentType", action.fields.agentType)
                    .put("command", action.fields.command).put("args", JSONArray(action.fields.args)).also { ProviderDetailsJson.advanced(it, action.fields.advanced) })
            }
            is ProviderAction.Delete -> { put("action", "delete"); put("base", provider(action.base)) }
            is ProviderAction.Refresh -> { put("action", "refresh"); put("base", provider(action.base)) }
            is ProviderAction.RetrySetup -> { put("action", "retrySetup"); put("setup", setup(action.setup)) }
            is ProviderAction.DeleteSetup -> { put("action", "deleteSetup"); put("setup", setup(action.setup)) }
        }
    }
}
