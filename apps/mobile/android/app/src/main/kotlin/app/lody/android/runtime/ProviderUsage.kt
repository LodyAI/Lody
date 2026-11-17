package app.lody.android.runtime

import org.json.JSONObject

/** Runtime owns capability/auth eligibility. Never match quota by display name. */
data class ProviderUsageConfig(val id: String, val provider: String, val eligible: Boolean)
data class ProviderQuota(val provider: String, val agentConfigId: String?, val quota: UsageQuota)
data class ProviderUsage(val configs: List<ProviderUsageConfig>, val quotas: List<ProviderQuota>) {
    fun forProvider(provider: AgentProvider): List<UsageQuota> {
        val config = configs.firstOrNull { it.id == provider.id && it.eligible } ?: return emptyList()
        if (provider.agentType != config.provider) return emptyList()
        return quotas.filter { it.provider == config.provider && (it.agentConfigId == null || it.agentConfigId == provider.id) }.map { it.quota }
    }
}

internal object ProviderUsageJson {
    fun parse(catalog: JSONObject): Map<String, ProviderUsage> {
        val machines = catalog.optJSONObject("agentUsage") ?: return emptyMap()
        return machines.keys().asSequence().mapNotNull { machine ->
            val value = machines.optJSONObject(machine) ?: return@mapNotNull null
            val configs = value.optJSONArray("configs")
            val quotas = value.optJSONArray("quotas")
            machine to ProviderUsage(
                (0 until (configs?.length() ?: 0)).mapNotNull { i ->
                    val c = configs?.optJSONObject(i) ?: return@mapNotNull null
                    val id = c.opt("id") as? String ?: return@mapNotNull null
                    val provider = c.opt("provider") as? String ?: return@mapNotNull null
                    ProviderUsageConfig(id, provider, c.opt("eligible") == true)
                },
                (0 until (quotas?.length() ?: 0)).mapNotNull { i ->
                    val q = quotas?.optJSONObject(i) ?: return@mapNotNull null
                    val provider = q.opt("provider") as? String ?: return@mapNotNull null
                    val quota = SessionUsageJson.parse(JSONObject().put("quotaEligible", true).put("quota", q))?.quota ?: return@mapNotNull null
                    ProviderQuota(provider, (q.opt("agentConfigId") as? String)?.takeIf { it.isNotBlank() }, quota)
                })
        }.toMap()
    }
}
