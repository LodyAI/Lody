package app.lody.android.runtime

/**
 * Schedules as the shared runtime describes them (`contract/schedules.ts`). A rule is named,
 * never cron: [kind] is `manual`, `once`, `minutes`, `hours`, `daily`, `weekdays`, `weekly`,
 * `monthly` or `unsupported` (a stored rule shown read-only through [summary]). [at] is epoch ms;
 * [weekdays] run Sunday = 0 … Saturday = 6; [days] are 1–31. Every field round-trips, so an
 * untouched rule goes back exactly as it came.
 */
data class ScheduleRule(
    val kind: String,
    val every: Int? = null,
    val hour: Int? = null,
    val minute: Int? = null,
    val weekdays: List<Int>? = null,
    val days: List<Int>? = null,
    val at: Long? = null,
    val timeZone: String? = null,
    val summary: String? = null,
)

/** Status in words: [kind] names it (`runsAt`, `paused`, `blocked`, …) and [at] is its time. */
data class ScheduleState(val group: String, val kind: String, val at: Long? = null, val blockedCode: String? = null)

/** A schedule's project: a local project ([localProjectId] on its computer) or a GitHub repository and branch. */
data class ScheduleProject(
    val kind: String,
    val localProjectId: String? = null,
    val repoFullName: String? = null,
    val branch: String? = null,
    val useWorktree: Boolean? = null,
    /** Display only; never sent back. */
    val name: String? = null,
)

data class ScheduleItem(
    val scheduleId: String,
    val title: String,
    val ownerId: String,
    val isOwner: Boolean,
    val machineId: String,
    val machineName: String? = null,
    val machineSupported: Boolean,
    val agentConfigId: String,
    val agentName: String? = null,
    val agentType: String? = null,
    val enabled: Boolean,
    val scheduledMessage: Boolean,
    val rule: ScheduleRule,
    /** `new_session`, `own_session` or `existing_session` (read only on mobile). */
    val destination: String,
    val destinationSessionId: String? = null,
    val projectKind: String? = null,
    val projectKey: String? = null,
    val projectName: String? = null,
    val state: ScheduleState,
    val lastRunAt: Long? = null,
    val lastSessionId: String? = null,
    val createdAt: Long,
    val updatedAt: Long,
)

/** The list plus the zones wall-clock rules are authored in: a machine's own, else the device's. */
data class ScheduleList(
    val items: List<ScheduleItem>,
    val deviceTimeZone: String,
    val machineTimeZones: Map<String, String>,
    /** Computers the signed-in user owns: the only ones a schedule can target. */
    val ownedMachineIds: Set<String> = emptySet(),
) {
    fun timeZone(machineId: String?): String = machineId?.let { machineTimeZones[it] } ?: deviceTimeZone
}

data class ScheduleDetail(val item: ScheduleItem, val prompt: String, val modelId: String? = null, val modeId: String? = null, val project: ScheduleProject? = null)

data class ScheduleDraft(
    val title: String,
    val prompt: String,
    val machineId: String,
    val agentConfigId: String,
    val modelId: String? = null,
    val modeId: String? = null,
    val project: ScheduleProject? = null,
    /** `new_session` or `own_session`. */
    val destination: String,
    val rule: ScheduleRule,
)

/**
 * One owner write. [requestId] is the idempotency key: fresh per intent, reused only to retry the
 * same attempt after `schedule_write_unknown`. [draft] goes with `create` / `edit` only.
 */
data class ScheduleCommandRequest(val action: String, val scheduleId: String, val requestId: String, val draft: ScheduleDraft? = null)
