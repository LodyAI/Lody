package app.lody.android.runtime

/** Display-only projection. Quota selection and authentication gating belong to the shared runtime. */
data class SessionUsage(
    val context: ContextUsage? = null,
    val compacting: Boolean = false,
    val quota: UsageQuota? = null,
    val modelId: String? = null,
) {
    val windows get() = quota?.windows.orEmpty().sortedByDescending { it.duration ?: 0.0 }
    val triggerPercent get() = context?.percent ?: (windows.firstOrNull { it.duration == 18000.0 } ?: windows.firstOrNull())?.usedPercent
    val visible get() = compacting || triggerPercent != null
}
data class ContextUsage(val used: Double, val size: Double) {
    val percent get() = (used / size * 100).coerceIn(0.0, 100.0)
}
data class UsageQuota(val name: String?, val windows: List<UsageWindow>)
data class UsageWindow(val label: String?, val usedPercent: Double, val duration: Double?, val resetsAt: Double?)
