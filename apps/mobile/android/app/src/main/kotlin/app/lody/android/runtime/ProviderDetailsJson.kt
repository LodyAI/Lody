package app.lody.android.runtime

import org.json.JSONArray
import org.json.JSONObject

internal object ProviderDetailsJson {
    private fun JSONObject.rows(key: String) = optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getJSONObject(it) } }.orEmpty()
    private fun JSONObject.strings(key: String) = optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
    private fun JSONObject.text(key: String) = optString(key).takeUnless { it.isEmpty() || it == "null" }
    private fun checked(value: JSONObject): JSONObject { if (value.has("error")) throw RuntimeException(RuntimeFault(value.getString("error"), RuntimeErrorCategory.BUSINESS)); return value }
    fun operationParams(command: RuntimeCommand.ProviderOperation) = JSONObject().put("machineId", command.machineId).put("action", command.action).apply {
        command.id?.let { put("id", it) }
        if (command.id == null && command.action in setOf("binary-status", "binary-install")) {
            put("cliType", command.cliType); put("agentType", command.agentType)
        }
    }
    fun target(machineId: String, id: String, readModelOptions: Boolean = false) = JSONObject().put("machineId", machineId).put("id", id)
        .apply { if (readModelOptions) put("readModelOptions", true) }
    private fun choices(value: JSONObject, key: String) = value.rows(key).map { ProviderChoice(it.getString("id"), it.getString("name")) }
    fun capabilities(v: JSONObject) = ProviderCapabilities(choices(v, "models"), choices(v, "modes"), v.optBoolean("sessionTitle"), v.rows("options").map {
        ProviderOption(it.getString("id"), it.getString("name"), it.getString("type"), (it.opt("value") as? String), it.opt("value") as? Boolean, choices(it, "choices"))
    }, choices(v, "authMethods"))
    fun presets(v: JSONObject) = v.rows("presets").map { p -> ProviderPreset(p.getString("id"), p.getString("name"), p.getString("cliType"), p.getString("agentType"), p.getString("tokenEnvKey"), p.strings("protectedEnvKeys"), p.rows("modes").map { m -> ProviderPresetMode(m.getString("id"), m.getString("name"), m.text("endpoint"), m.text("tokenPrefix"), m.optBoolean("customEndpoint"), m.rows("endpoints").map { ProviderEndpoint(it.getString("id"), it.getString("name"), it.getString("url")) }) }) }
    fun detail(value: JSONObject): ProviderDetail {
        val v = checked(value); val overrides = v.getJSONObject("runtimeOverrides")
        val title = v.optJSONObject("titleGeneration")?.optJSONObject("configOptionValues")
        val auth = v.optJSONObject("codexAuth")
        return ProviderDetail(v.getString("id"), v.getString("machineId"), v.getString("revision"), v.optString("description"), v.rows("env").map { it.getString("key") },
            v.rows("endpoints").associate { it.getString("key") to it.getString("value") },
            overrides.keys().asSequence().filter { it != "piExtensions" && overrides.opt(it) is String }.associateWith { overrides.getString(it) }, overrides.strings("piExtensions"),
            title?.keys()?.asSequence()?.associateWith { title.get(it) }.orEmpty(),
            auth?.let { ProviderCodexAuth(it.getString("mode"), it.getString("profileId"), it.text("baseUrl")) }, v.text("presetId"), capabilities(v.getJSONObject("capabilities")), v.optBoolean("supportsAuthentication"), v.optBoolean("supportsMethodSelection"), v.optBoolean("supportsCodexProfiles"), v.optBoolean("supportsPiExtensions"), v.rows("unavailableActions").associate { it.getString("action") to it.getString("reason") }, v.optBoolean("supportsRateLimitsRefresh"))
    }
    fun probe(value: JSONObject): ProviderProbe { val v = checked(value); return ProviderProbe(v.getBoolean("success"), v.getBoolean("authRequired"), capabilities(v.getJSONObject("capabilities"))) }
    fun auth(value: JSONObject): ProviderAuthState {
        val v = checked(value)
        return ProviderAuthState(v.getString("flowId"), v.getString("status"), choices(v, "methods"), v.rows("fields").map { f -> ProviderAuthField(f.getString("id"), f.getString("label"), f.getString("type"), f.optBoolean("required"), f.rows("options").map { ProviderChoice(it.getString("value"), it.getString("label")) }) }, v.text("interactionId"), v.text("authorizationUrl"), v.text("userCode"), v.optBoolean("acceptsAuthorizationCode"), v.text("errorCode"), v.optBoolean("requiresAuthorizationConsent"))
    }
    fun operation(value: JSONObject): ProviderOperation {
        val v = checked(value)
        return ProviderOperation(v.getString("action"), v.getBoolean("success"), v.text("status"), v.rows("extensions").map { ProviderChoice(it.getString("path"), it.getString("name")) }, v.text("version"), v.text("current"), v.text("required"), v.text("errorCode"))
    }
    fun authRequest(r: ProviderAuthRequest) = target(r.machineId, r.id).put("action", r.action).put("flowId", r.flowId).apply {
        r.responseAction?.let { put("responseAction", it) }; r.methodId?.let { put("methodId", it) }; r.interactionId?.let { put("interactionId", it) }
        r.values?.let { put("values", JSONObject(it)) }; r.authorizationCode?.let { put("authorizationCode", it) }
    }
    fun advanced(fields: JSONObject, a: ProviderAdvanced?) { if (a == null) return
        a.detailRevision?.let { fields.put("detailRevision", it) }; a.description?.let { fields.put("description", it) }
        a.envPatch?.let { values -> fields.put("envPatch", JSONObject().apply { values.forEach { (k,v) -> put(k, v ?: JSONObject.NULL) } }) }
        if (a.runtimePaths != null || a.piExtensions != null) fields.put("runtimeOverrides", JSONObject().apply {
            put("action", "merge")
            put("value", JSONObject().apply { a.runtimePaths?.filterValues { it != null }?.forEach { (k,v) -> put(k, v) }; a.piExtensions?.let { put("piExtensions", JSONArray(it)) } })
            put("remove", JSONArray(a.runtimePaths?.filterValues { it == null }?.keys.orEmpty()))
        })
        a.titleValues?.let { fields.put("titleGeneration", JSONObject().put("action", "set").put("value", JSONObject().put("configOptionValues", JSONObject(it)))) }
        a.codexAuth?.let { fields.put("codexAuth", JSONObject().put("mode", it.mode).put("profileId", it.profileId).apply { it.baseUrl?.let { url -> put("baseUrl", url) } }) }
        a.presetId?.let { fields.put("presetId", it) }; a.presetModeId?.let { fields.put("presetModeId", it) }; a.presetEndpoint?.let { fields.put("presetEndpoint", it) }
    }
}
