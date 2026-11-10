import Foundation
import LodyCore

/// One vocabulary for schedules, as web `schedule-format.ts`: rules and states in words. Wall-clock
/// rules read on the target machine's clock; a scheduled message reads on the viewer's clock.
@MainActor
enum ScheduleFormat {
  static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue("schedules." + key), bundle: .lody)
  }

  private static func format(_ key: String, _ arguments: CVarArg...) -> String {
    String(format: text(key), locale: Locale.current, arguments: arguments)
  }

  /// The zone a schedule's times are shown in.
  static func zone(_ item: ScheduleItem, result: RuntimeContract.SchedulesResult?) -> TimeZone {
    if item.scheduledMessage { return .current }
    return machineZone(item.machineId, rule: item.rule, result: result)
  }

  /// A wall-clock rule keeps its authored zone; otherwise the machine's, else the runtime device's.
  static func machineZone(_ machineId: String, rule: ScheduleRule? = nil, result: RuntimeContract.SchedulesResult?) -> TimeZone {
    let names = [rule?.timeZone, result?.machineTimeZones[machineId], result?.deviceTimeZone]
    return names.compactMap { $0.flatMap(TimeZone.init(identifier:)) }.first ?? .current
  }

  // MARK: Rules

  static func timeOfDay(hour: Int, minute: Int) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
    let date = calendar.date(from: DateComponents(year: 2023, month: 1, day: 1, hour: hour, minute: minute)) ?? Date()
    let formatter = DateFormatter()
    formatter.timeZone = calendar.timeZone
    formatter.setLocalizedDateFormatFromTemplate("jmm")
    return formatter.string(from: date)
  }

  static func instant(_ at: Double, zone: TimeZone) -> String {
    let formatter = DateFormatter()
    formatter.timeZone = zone
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter.string(from: Date(timeIntervalSince1970: at / 1000))
  }

  /// Short weekday names, Sunday first (cron's 0).
  static var weekdayNames: [String] {
    let formatter = DateFormatter()
    return formatter.shortWeekdaySymbols ?? []
  }

  /// The single-letter weekday names the weekly toggles show, Sunday first.
  static var weekdayInitials: [String] {
    let formatter = DateFormatter()
    return formatter.veryShortWeekdaySymbols ?? []
  }

  static func list(_ values: [String]) -> String {
    ListFormatter.localizedString(byJoining: values)
  }

  /// The rule in plain words ("Every weekday at 9:00 AM").
  static func summary(_ rule: ScheduleRule, zone: TimeZone) -> String {
    let time = timeOfDay(hour: rule.hour ?? 0, minute: rule.minute ?? 0)
    switch rule.kind {
    case .manual: return text("trigger.manual")
    case .once: return format("summary.once", instant(rule.at ?? 0, zone: zone))
    case .minutes: return String.localizedStringWithFormat(text("summary.minutes"), rule.every ?? 0)
    case .hours: return String.localizedStringWithFormat(text("summary.hours"), rule.every ?? 0)
    case .daily: return format("summary.daily", time)
    case .weekdays: return format("summary.weekdays", time)
    case .weekly:
      let names = weekdayNames
      let days = (rule.weekdays ?? []).sorted().compactMap { names.indices.contains($0) ? names[$0] : nil }
      return days.isEmpty ? text("requireWeekday") : format("summary.weekly", list(days), time)
    case .monthly:
      let days = (rule.days ?? []).sorted().map(String.init)
      return days.isEmpty ? text("requireMonthDay") : format("summary.monthly", list(days), time)
    case .unsupported: return format("summary.unsupported", rule.summary ?? "")
    }
  }

  // MARK: States

  /// "9:00 AM" today, "Tomorrow 9:00 AM", "Tue 9:00 AM" within the week, else "Nov 12 9:00 AM".
  static func upcoming(_ at: Double, zone: TimeZone, now: Double = LodyRelativeTime.now()) -> String {
    var calendar = Calendar.current
    calendar.timeZone = zone
    let date = Date(timeIntervalSince1970: at / 1000)
    let today = Date(timeIntervalSince1970: now / 1000)
    let time = DateFormatter()
    time.timeZone = zone
    time.setLocalizedDateFormatFromTemplate("jmm")
    let clock = time.string(from: date)
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: today), to: calendar.startOfDay(for: date)).day ?? 0
    if days == 0 { return clock }
    let prefix = DateFormatter()
    prefix.timeZone = zone
    if days == 1 {
      prefix.dateStyle = .medium
      prefix.doesRelativeDateFormatting = true
    } else if days > 1, days < 6 {
      prefix.setLocalizedDateFormatFromTemplate("EEE")
    } else {
      prefix.setLocalizedDateFormatFromTemplate("MMMd")
    }
    return "\(prefix.string(from: date)) \(clock)"
  }

  /// Why a blocked schedule needs a look, when the runtime names a known reason.
  static func blockedReason(_ code: String?) -> String? {
    guard let code, ScheduleFormat.blockedCodes.contains(code) else { return nil }
    return text("blocked." + code)
  }

  static let blockedCodes: Set<String> = [
    "PERMISSION_UNAVAILABLE", "CAPACITY_EXHAUSTED", "E2EE_SCHEDULE_NOT_AUTHORIZED", "OWNER_OR_AGENT_UNAVAILABLE",
    "PROJECT_UNAVAILABLE", "DEFINITION_NOT_COMMITTED", "DEFINITION_UNAVAILABLE", "DISPATCH_UNAVAILABLE",
    "SCHEDULES_DISABLED", "SESSION_BUSY", "LEGACY_QUOTA_UNASSOCIATED", "QUOTA_RECOVERY_ALREADY_ACCEPTED",
    "AUTOMATION_OWNER_UNAVAILABLE",
  ]

  /// What the schedule is doing, in words: a main label and an optional detail.
  static func state(_ state: RuntimeContract.ScheduleState, zone: TimeZone, now: Double = LodyRelativeTime.now()) -> (label: String, detail: String?) {
    let at = state.at.map { upcoming($0, zone: zone, now: now) }
    switch state.kind {
    case .sent: return (text("status.sent"), at)
    case .cancelled: return (text("status.cancelled"), at.map { format("status.wasPlanned", $0) })
    case .notSent: return (text("status.notSent"), blockedReason(state.blockedCode))
    case .cancelling: return (text("status.cancelling"), nil)
    case .sendsAt: return (at.map { format("status.sendsAt", $0) } ?? text("status.waiting"), nil)
    case .waitingToSend: return (text("status.waiting"), nil)
    case .paused: return (text("paused"), nil)
    case .blocked: return (text("state.blocked"), blockedReason(state.blockedCode))
    case .retrying: return (text("state.retrying"), nil)
    case .due: return (text("state.due"), at)
    case .waitingForAgent: return (text("state.waitingForAgent"), at)
    case .manual: return (text("status.manual"), at.map { format("status.lastRan", $0) })
    case .runsAt: return (at.map { format("status.runsAt", $0) } ?? text("notScheduledYet"), nil)
    case .done: return (text("status.done"), at)
    case .notScheduled: return (text("notScheduledYet"), text("awaitingMachine"))
    }
  }

  /// Line 2 of a row: frequency · agent · computer.
  static func detail(_ item: ScheduleItem, zone: TimeZone) -> String {
    [summary(item.rule, zone: zone), item.agentName ?? "", item.machineName ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
  }
}
