package app.lody.android.schedules

import app.lody.android.runtime.CatalogProject
import app.lody.android.runtime.CatalogSnapshot
import app.lody.android.runtime.ScheduleCommandRequest
import app.lody.android.runtime.ScheduleDetail
import app.lody.android.runtime.ScheduleDraft
import app.lody.android.runtime.ScheduleItem
import app.lody.android.runtime.ScheduleProject
import app.lody.android.runtime.ScheduleRule
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID

/** The named frequencies the editor offers (web `schedule-recurrence-editor`), never cron. */
enum class Frequency(val kind: String) {
    Manual("manual"), Daily("daily"), Weekdays("weekdays"), Weekly("weekly"), Monthly("monthly"),
    Hours("hours"), Minutes("minutes"), Once("once"),
    /** A stored rule no named kind expresses: read-only until replaced. */
    Unsupported("unsupported");

    companion object {
        /** What the frequency menu offers (Unsupported is only ever received). */
        val choices = entries - Unsupported
        fun of(kind: String) = entries.firstOrNull { it.kind == kind } ?: Unsupported
    }
}

/**
 * The editor's state, pure so it can be tested. [original] is the rule as received; while
 * [ruleTouched] is false it goes back unchanged. [projectId] is the catalog project id
 * (`<machine>:local:<id>` or `github:<owner>/<repo>`), null for a plain chat.
 */
data class ScheduleForm(
    val title: String = "",
    val prompt: String = "",
    val machineId: String? = null,
    val agentConfigId: String? = null,
    val modelId: String? = null,
    val modeId: String? = null,
    val projectId: String? = null,
    val branch: String = "",
    /** Kept from a stored local project (not editable here). */
    val useWorktree: Boolean? = null,
    val destination: String = NEW_SESSION,
    val frequency: Frequency = Frequency.Daily,
    val hour: Int = 9,
    val minute: Int = 0,
    val weekdays: Set<Int> = setOf(1),
    val days: Set<Int> = setOf(1),
    val everyHours: Int = 1,
    val everyMinutes: Int = 30,
    val onceAt: Long? = null,
    val original: ScheduleRule? = null,
    val ruleTouched: Boolean = true,
) {
    /** Any frequency or time change detaches the received rule. */
    fun editRule(change: ScheduleForm.() -> ScheduleForm): ScheduleForm = change().copy(ruleTouched = true)

    val isGithub: Boolean get() = projectId?.startsWith(GITHUB_PREFIX) == true

    companion object {
        const val NEW_SESSION = "new_session"
        const val OWN_SESSION = "own_session"
        const val EXISTING_SESSION = "existing_session"
        const val GITHUB_PREFIX = "github:"
        /** Wheel ranges for "every N hours / minutes"; 60 minutes is offered as 1 hour. */
        val EVERY_HOURS = 1..24
        val EVERY_MINUTES = 1..59
        /** Monday–Friday (Sunday = 0). */
        val WORKWEEK = setOf(1, 2, 3, 4, 5)
    }
}

object ScheduleForms {
    /** A new schedule: the first computer and agent offered, a daily 09:00 rule. */
    fun blank(machineId: String?, agentConfigId: String?, now: Long, zone: ZoneId): ScheduleForm =
        ScheduleForm(machineId = machineId, agentConfigId = agentConfigId, onceAt = nextHour(now, zone))

    /** An existing schedule; its rule stays as received until the reader changes it. */
    fun of(detail: ScheduleDetail, now: Long, zone: ZoneId): ScheduleForm {
        val item = detail.item
        val rule = item.rule
        val project = detail.project
        return ScheduleForm(
            title = item.title, prompt = detail.prompt,
            machineId = item.machineId, agentConfigId = item.agentConfigId,
            modelId = detail.modelId, modeId = detail.modeId,
            projectId = project?.let { catalogId(it, item.machineId) },
            branch = project?.branch.orEmpty(),
            useWorktree = project?.useWorktree,
            destination = item.destination,
            frequency = Frequency.of(rule.kind),
            hour = rule.hour ?: 9, minute = rule.minute ?: 0,
            weekdays = rule.weekdays?.toSet()?.ifEmpty { null } ?: setOf(1),
            days = rule.days?.toSet()?.ifEmpty { null } ?: setOf(1),
            everyHours = rule.every?.takeIf { rule.kind == "hours" } ?: 1,
            everyMinutes = rule.every?.takeIf { rule.kind == "minutes" } ?: 30,
            onceAt = rule.at ?: nextHour(now, zone),
            original = rule, ruleTouched = false,
        )
    }

    /** The catalog id of a schedule's project, to match it against the picker. */
    fun catalogId(project: ScheduleProject, machineId: String): String? = when (project.kind) {
        "github" -> project.repoFullName?.let { ScheduleForm.GITHUB_PREFIX + it }
        "local" -> project.localProjectId?.let { "$machineId:local:$it" }
        else -> null
    }

    /** Projects usable on [machineId]: its local projects and every GitHub repository; groups and chats are not schedule projects. */
    fun projects(snapshot: CatalogSnapshot?, machineId: String?): List<CatalogProject> =
        snapshot?.projects.orEmpty().filter { project ->
            !project.id.endsWith(":unassigned") && !project.id.startsWith("group:") &&
                (project.id.startsWith(ScheduleForm.GITHUB_PREFIX) || (machineId != null && project.machineId == machineId))
        }.sortedBy { it.name.lowercase() }

    /** The rule to save: the received one while untouched, else the named rule in [zone]. */
    fun rule(form: ScheduleForm, zone: String): ScheduleRule? {
        if (!form.ruleTouched && form.original != null) return form.original
        return when (form.frequency) {
            Frequency.Manual -> ScheduleRule("manual")
            Frequency.Daily -> ScheduleRule("daily", hour = form.hour, minute = form.minute, timeZone = zone)
            Frequency.Weekdays -> ScheduleRule("weekdays", hour = form.hour, minute = form.minute, timeZone = zone)
            Frequency.Weekly -> form.weekdays.takeIf { it.isNotEmpty() }?.let { ScheduleRule("weekly", hour = form.hour, minute = form.minute, weekdays = it.sorted(), timeZone = zone) }
            Frequency.Monthly -> form.days.takeIf { it.isNotEmpty() }?.let { ScheduleRule("monthly", hour = form.hour, minute = form.minute, days = it.sorted(), timeZone = zone) }
            Frequency.Hours -> ScheduleRule("hours", every = form.everyHours, timeZone = zone)
            Frequency.Minutes -> ScheduleRule("minutes", every = form.everyMinutes, timeZone = zone)
            Frequency.Once -> form.onceAt?.let { ScheduleRule("once", at = it) }
            Frequency.Unsupported -> null
        }
    }

    /** The project to save; a GitHub repository needs a branch. */
    fun project(form: ScheduleForm, snapshot: CatalogSnapshot?): ScheduleProject? {
        val id = form.projectId ?: return null
        if (form.isGithub) return ScheduleProject("github", repoFullName = id.removePrefix(ScheduleForm.GITHUB_PREFIX), branch = form.branch.trim())
        val machine = form.machineId ?: return null
        val local = id.removePrefix("$machine:local:").takeIf { it != id } ?: return null
        val repo = snapshot?.projects?.firstOrNull { it.id == id }?.repoFullName
        return ScheduleProject("local", localProjectId = local, branch = form.branch.trim().ifEmpty { null }?.takeIf { repo != null }, useWorktree = form.useWorktree)
    }

    /** The draft to send, or null while something the save needs is missing. */
    fun draft(form: ScheduleForm, zone: String, snapshot: CatalogSnapshot?): ScheduleDraft? {
        val machine = form.machineId ?: return null
        val agent = form.agentConfigId ?: return null
        if (form.title.isBlank() || form.prompt.isBlank()) return null
        if (form.destination != ScheduleForm.NEW_SESSION && form.destination != ScheduleForm.OWN_SESSION) return null
        val rule = rule(form, zone) ?: return null
        val project = if (form.projectId == null) null else project(form, snapshot) ?: return null
        if (project?.kind == "github" && project.branch.isNullOrEmpty()) return null
        return ScheduleDraft(form.title.trim(), form.prompt, machine, agent, form.modelId, form.modeId, project, form.destination, rule)
    }

    /** Whether the reader may change this schedule's settings here (iOS / web read-only rules). */
    fun editable(item: ScheduleItem?): Boolean =
        item == null || (item.isOwner && !item.scheduledMessage && item.destination != ScheduleForm.EXISTING_SESSION)

    /**
     * A command for one intent. The same attempt retried after an unknown outcome keeps its
     * [previous] request id; anything else gets a fresh one.
     */
    fun request(action: String, scheduleId: String, draft: ScheduleDraft?, previous: ScheduleCommandRequest?, ids: () -> String = { ScheduleForms.newId() }): ScheduleCommandRequest {
        val candidate = ScheduleCommandRequest(action, scheduleId, "", draft)
        return if (previous != null && previous.copy(requestId = "") == candidate) previous else candidate.copy(requestId = ids())
    }

    /** Schedule and request ids: lowercase UUIDs. */
    fun newId(): String = UUID.randomUUID().toString().lowercase()

    /** The wall-clock date and time of [at] in [zone], for the once pickers. */
    fun local(at: Long, zone: ZoneId): ZonedDateTime = Instant.ofEpochMilli(at).atZone(zone)

    private fun nextHour(now: Long, zone: ZoneId): Long =
        local(now, zone).plusHours(1).withMinute(0).withSecond(0).withNano(0).toInstant().toEpochMilli()
}
