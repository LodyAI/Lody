import Foundation

/// Display-only projection. Runtime owns provider eligibility and exact config/model matching.
struct ChatSessionUsage: Codable, Equatable {
  struct Context: Codable, Equatable {
    var used: Double
    var size: Double
    var percentage: Double? {
      guard size.isFinite, size > 0 else { return nil }
      return min(100, max(0, (used.isFinite ? used : 0) / size * 100))
    }
  }
  struct Window: Codable, Equatable {
    var label: String?
    var usedPercent: Double
    var duration: Double?
    var resetsAt: Double?
    var percentage: Double { min(100, max(0, usedPercent)) }
  }
  struct RateLimit: Codable, Equatable {
    var name: String?
    var windows: [Window]
  }
  var context: Context?
  var isContextCompacting: Bool?
  var modelLabel: String?
  var modelId: String?
  var quota: RateLimit?
  var quotaEligible: Bool?

  var windows: [Window] {
    (quota?.windows ?? []).filter { $0.usedPercent.isFinite }.sorted { ($0.duration ?? 0) > ($1.duration ?? 0) }
  }
  var percentage: Double? {
    if let value = context?.percentage { return value }
    guard quotaEligible == true else { return nil }
    return (windows.first { $0.duration == 18_000 } ?? windows.first)?.percentage
  }
  var visible: Bool { isContextCompacting == true || percentage != nil }
  var title: String {
    for value in [modelLabel, quota?.name] {
      if let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty { return value }
    }
    return Self.text("model")
  }
  static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue("chat.usage." + key), bundle: .lody)
  }
  static func used(_ percent: Double) -> String {
    String.localizedStringWithFormat(text("used"), Int(percent.rounded()))
  }
  static func label(_ window: Window) -> String {
    let duration: String
    switch window.duration {
    case 604_800: duration = text("weekly")
    case 18_000: duration = text("fiveHours")
    case let seconds? where seconds.isFinite:
      if seconds.truncatingRemainder(dividingBy: 86_400) == 0 { duration = "\((seconds / 86_400).formatted())d" }
      else if seconds.truncatingRemainder(dividingBy: 3_600) == 0 { duration = "\((seconds / 3_600).formatted())h" }
      else { duration = "\((seconds / 60).formatted())m" }
    default: duration = text("title")
    }
    let name = window.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return name.isEmpty ? duration : "\(duration) · \(name)"
  }
}

struct ChatUsageReset {
  var absolute = false
  mutating func toggle() { absolute.toggle() }
  var toggleLabel: String { ChatSessionUsage.text(absolute ? "relative" : "absolute") }
  func text(epoch: Double, now: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
    String.localizedStringWithFormat(ChatSessionUsage.text("resets"), value(epoch: epoch, now: now, locale: locale, timeZone: timeZone))
  }
  func value(epoch: Double, now: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
    let date = Date(timeIntervalSince1970: epoch)
    let time: String
    if absolute {
      let format = DateFormatter()
      format.locale = locale
      format.timeZone = timeZone
      format.dateStyle = .medium
      format.timeStyle = .short
      time = format.string(from: date)
    } else {
      let format = RelativeDateTimeFormatter()
      format.locale = locale
      format.unitsStyle = .full
      time = format.localizedString(for: date, relativeTo: now)
    }
    return time
  }
}
