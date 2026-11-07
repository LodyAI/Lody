package app.lody.android.runtime

import org.json.JSONObject

internal object SessionUsageJson {
    fun parse(value: JSONObject?): SessionUsage? {
        value ?: return null
        val context = value.optJSONObject("context")?.let {
            val size = it.number("size")?.takeIf { n -> n > 0 } ?: return@let null
            ContextUsage((it.number("used") ?: 0.0).coerceAtLeast(0.0), size)
        }
        // Eligibility and exact provider/config/model selection are owned by the runtime.
        val quota = value.optJSONObject("quota")?.takeIf { value.opt("quotaEligible") == true }?.let { q ->
            val windows = q.optJSONArray("windows")
            UsageQuota(value.label("modelLabel") ?: q.label("name"), (0 until (windows?.length() ?: 0)).mapNotNull { index ->
                val w = windows?.optJSONObject(index) ?: return@mapNotNull null
                val used = w.number("usedPercent") ?: return@mapNotNull null
                UsageWindow(w.label("label"), used.coerceIn(0.0, 100.0), w.number("duration")?.takeIf { it > 0 }, w.number("resetsAt")?.takeIf { it > 0 && it < 253402300800.0 })
            })
        }
        return SessionUsage(context, value.opt("isContextCompacting") == true, quota, value.label("modelId"))
    }
    private fun JSONObject.number(key: String) = (opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() }
    private fun JSONObject.label(key: String) = (opt(key) as? String)?.trim()?.takeIf { it.isNotEmpty() }
}
