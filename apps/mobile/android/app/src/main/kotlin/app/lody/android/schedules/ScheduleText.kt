// Schedule vocabulary (web `schedule-format.ts`): rule summaries, status in words and error copy.
package app.lody.android.schedules

import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import app.lody.android.R
import app.lody.android.runtime.ScheduleRule
import app.lody.android.runtime.ScheduleState
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

@Composable
private fun locale(): Locale = LocalConfiguration.current.locales[0] ?: Locale.ROOT

/** A time of day in the reader's 12/24-hour preference. */
@Composable
fun timeOfDay(hour: Int, minute: Int): String {
    val pattern = DateFormat.getBestDateTimePattern(locale(), if (DateFormat.is24HourFormat(LocalContext.current)) "Hm" else "hm")
    return LocalTime.of(hour.coerceIn(0, 23), minute.coerceIn(0, 59)).format(DateTimeFormatter.ofPattern(pattern, locale()))
}

/** A moment in [zone]: the time alone today, else a short date and time. */
@Composable
fun moment(at: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    val time = Instant.ofEpochMilli(at).atZone(zone)
    val today = time.toLocalDate() == java.time.LocalDate.now(zone)
    val clock = if (DateFormat.is24HourFormat(LocalContext.current)) "Hm" else "hm"
    val pattern = DateFormat.getBestDateTimePattern(locale(), if (today) clock else "MMMd$clock")
    return time.format(DateTimeFormatter.ofPattern(pattern, locale()))
}

/** A date alone, for the once date row. */
@Composable
fun dateText(at: Long, zone: ZoneId): String =
    Instant.ofEpochMilli(at).atZone(zone).format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale(), "yMMMd"), locale()))

/** Sunday = 0 … Saturday = 6, as the contract numbers them. */
@Composable
fun weekdayName(day: Int, style: TextStyle = TextStyle.SHORT): String =
    DayOfWeek.of(if (day == 0) 7 else day).getDisplayName(style, locale())

/** Weekdays in display order, Monday first (Sunday = 0 last). */
val WeekOrder = listOf(1, 2, 3, 4, 5, 6, 0)

@Composable
fun frequencyLabel(frequency: Frequency): String = stringResource(
    when (frequency) {
        Frequency.Manual -> R.string.schedules_repeat_manual
        Frequency.Daily -> R.string.schedules_repeat_daily
        Frequency.Weekdays -> R.string.schedules_repeat_weekdays
        Frequency.Weekly -> R.string.schedules_repeat_weekly
        Frequency.Monthly -> R.string.schedules_repeat_monthly
        Frequency.Hours -> R.string.schedules_repeat_hours
        Frequency.Minutes -> R.string.schedules_repeat_minutes
        Frequency.Once -> R.string.schedules_repeat_once
        Frequency.Unsupported -> R.string.schedules_repeat_unsupported
    },
)

@Composable
fun everyHours(count: Int): String = pluralStringResource(R.plurals.schedules_every_hours, count, count)

@Composable
fun everyMinutes(count: Int): String = pluralStringResource(R.plurals.schedules_every_minutes, count, count)

/** The rule in words ("Every weekday at 09:00"); wall-clock rules read in their own zone. */
@Composable
fun ruleSummary(rule: ScheduleRule): String {
    val time = timeOfDay(rule.hour ?: 0, rule.minute ?: 0)
    return when (Frequency.of(rule.kind)) {
        Frequency.Manual -> stringResource(R.string.schedules_repeat_manual)
        Frequency.Daily -> stringResource(R.string.schedules_summary_daily, time)
        Frequency.Weekdays -> stringResource(R.string.schedules_summary_weekdays, time)
        Frequency.Weekly -> {
            val days = WeekOrder.filter { it in rule.weekdays.orEmpty() }.map { weekdayName(it) }
            stringResource(R.string.schedules_summary_weekly, days.joinToString(stringResource(R.string.schedules_list_separator)), time)
        }
        Frequency.Monthly -> stringResource(R.string.schedules_summary_monthly, rule.days.orEmpty().sorted().joinToString(stringResource(R.string.schedules_list_separator)), time)
        Frequency.Hours -> everyHours(rule.every ?: 1)
        Frequency.Minutes -> everyMinutes(rule.every ?: 1)
        Frequency.Once -> rule.at?.let { stringResource(R.string.schedules_summary_once, moment(it, zoneOf(rule.timeZone))) } ?: stringResource(R.string.schedules_repeat_once)
        Frequency.Unsupported -> stringResource(R.string.schedules_summary_unsupported, rule.summary.orEmpty())
    }
}

fun zoneOf(id: String?): ZoneId = try { id?.let(ZoneId::of) ?: ZoneId.systemDefault() } catch (_: Exception) { ZoneId.systemDefault() }

/** Status in words from the runtime's state (web `describeScheduleState`), on the reader's clock. */
data class StatusText(val label: String, val detail: String?)

@Composable
fun statusText(state: ScheduleState): StatusText {
    val at = state.at?.let { moment(it) }
    val blocked = state.blockedCode?.let { blockedText(it) }
    @Composable fun timed(resource: Int, fallback: Int): String = at?.let { stringResource(resource, it) } ?: stringResource(fallback)
    @Composable fun text(resource: Int) = stringResource(resource)
    return when (state.kind) {
        "sent" -> StatusText(text(R.string.schedules_status_sent), at)
        "cancelled" -> StatusText(text(R.string.schedules_status_cancelled), at?.let { stringResource(R.string.schedules_status_was_due, it) })
        "notSent" -> StatusText(text(R.string.schedules_status_not_sent), blocked)
        "cancelling" -> StatusText(text(R.string.schedules_status_cancelling), null)
        "sendsAt" -> StatusText(timed(R.string.schedules_status_sends_at, R.string.schedules_status_waiting), null)
        "waitingToSend" -> StatusText(text(R.string.schedules_status_waiting), null)
        "paused" -> StatusText(text(R.string.schedules_status_paused), null)
        "blocked" -> StatusText(text(R.string.schedules_status_blocked), blocked)
        "retrying" -> StatusText(text(R.string.schedules_status_retrying), null)
        "due" -> StatusText(text(R.string.schedules_status_due), at)
        "waitingForAgent" -> StatusText(text(R.string.schedules_status_waiting_agent), at)
        "manual" -> StatusText(text(R.string.schedules_status_manual), at?.let { stringResource(R.string.schedules_status_last_ran, it) })
        "runsAt" -> StatusText(timed(R.string.schedules_status_runs_at, R.string.schedules_status_not_scheduled), null)
        "done" -> StatusText(text(R.string.schedules_status_done), at)
        else -> StatusText(text(R.string.schedules_status_not_scheduled), null)
    }
}

/** Why a run is blocked (web `schedules.errors.<code>`); unknown codes add nothing. */
@Composable
fun blockedText(code: String): String? = when (code) {
    "PERMISSION_UNAVAILABLE" -> R.string.schedules_blocked_permission_unavailable
    "CAPACITY_EXHAUSTED" -> R.string.schedules_blocked_capacity_exhausted
    "E2EE_SCHEDULE_NOT_AUTHORIZED" -> R.string.schedules_blocked_not_authorized
    "OWNER_OR_AGENT_UNAVAILABLE" -> R.string.schedules_blocked_owner_or_agent
    "PROJECT_UNAVAILABLE" -> R.string.schedules_blocked_project
    "DEFINITION_NOT_COMMITTED" -> R.string.schedules_blocked_not_committed
    "DEFINITION_UNAVAILABLE" -> R.string.schedules_blocked_definition
    "DISPATCH_UNAVAILABLE" -> R.string.schedules_blocked_dispatch
    "SCHEDULES_DISABLED" -> R.string.schedules_blocked_disabled
    "SESSION_BUSY" -> R.string.schedules_blocked_session_busy
    "LEGACY_QUOTA_UNASSOCIATED" -> R.string.schedules_blocked_legacy_quota
    "QUOTA_RECOVERY_ALREADY_ACCEPTED" -> R.string.schedules_blocked_quota_accepted
    "AUTOMATION_OWNER_UNAVAILABLE" -> R.string.schedules_blocked_automation_owner
    else -> null
}?.let { stringResource(it) }

/** A read or write failure in words; `schedule_write_unknown` asks the reader to check first. */
@Composable
fun failureText(code: String): String = stringResource(
    when (code) {
        "schedule_not_found", "schedule_deleted" -> R.string.schedules_error_not_found
        "schedule_not_owner" -> R.string.schedules_error_not_owner
        "schedule_machine_unsupported", "unsupported_command" -> R.string.schedules_upgrade
        "schedule_prompt_invalid" -> R.string.schedules_error_prompt
        "schedule_trigger_invalid" -> R.string.schedules_error_trigger
        "schedule_title_invalid" -> R.string.schedules_error_title
        "schedule_message_read_only" -> R.string.schedules_message_read_only
        "schedule_conflict" -> R.string.schedules_error_conflict
        "schedule_invalid" -> R.string.schedules_error_invalid
        "schedule_write_unknown" -> R.string.schedules_error_unknown
        "metadata_not_ready" -> R.string.schedules_error_not_ready
        "workspace_changed" -> R.string.schedules_error_workspace_changed
        else -> R.string.schedules_error_generic
    },
)
