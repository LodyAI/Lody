import Foundation

struct LodyListState {
  var loading = false
  var notice: LodyListNotice?
  var unavailable: LodyListUnavailable?

  static func make(
    title: String,
    hasData: Bool,
    loading: Bool = false,
    failed: Bool = false,
    offline: Bool = false,
    unconfirmed: Bool = false,
    partial: String? = nil,
    syncedAt: Double? = nil,
    now: Double = LodyRelativeTime.now()
  ) -> LodyListState {
    if unconfirmed {
      return LodyListState(notice: warning("exclamationmark.triangle", text("unconfirmed")))
    }
    if failed && !hasData {
      var unavailable = LodyListUnavailable()
      unavailable.symbol = "wifi.exclamationmark"
      unavailable.title = title
      unavailable.message = text("unavailableMessage")
      unavailable.actionTitle = text("tryAgain")
      return LodyListState(unavailable: unavailable)
    }
    if failed {
      let message = syncedAt.map { String.localizedStringWithFormat(String(localized: "settings.state.staleAt", bundle: .lody), String(describing: LodyRelativeTime.text($0, now: now))) } ?? text("stale")
      return LodyListState(notice: warning("exclamationmark.icloud", message))
    }
    if let partial {
      return LodyListState(notice: warning("exclamationmark.triangle", partial))
    }
    if offline && hasData {
      var notice = LodyListNotice()
      notice.symbol = "icloud.slash"
      notice.text = text("offline")
      return LodyListState(notice: notice)
    }
    return LodyListState(loading: loading && !hasData)
  }

  private static func warning(_ symbol: String, _ message: String) -> LodyListNotice {
    var notice = LodyListNotice()
    notice.symbol = symbol
    notice.text = message
    notice.tint = "warning"
    notice.actionSymbol = "arrow.clockwise"
    notice.actionLabel = text("refresh")
    return notice
  }

  private static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue("settings.state." + key), bundle: .lody)
  }
}

enum LodyRelativeTime {
  private static let minute = 60_000.0
  private static let hour = 60 * minute
  private static let day = 24 * hour

  static func now() -> Double { Date().timeIntervalSince1970 * 1000 }

  static func compact(_ value: Double, now: Double = now(), calendar: Calendar = .current) -> String {
    guard value.isFinite else { return "" }
    let elapsed = now - value
    if elapsed < minute { return String(localized: "time.compact.now", bundle: .lody) }
    if elapsed < hour { return String.localizedStringWithFormat(String(localized: "time.compact.minutes", bundle: .lody), Int(elapsed / minute)) }
    if elapsed < day { return String.localizedStringWithFormat(String(localized: "time.compact.hours", bundle: .lody), Int(elapsed / hour)) }
    if elapsed < 7 * day { return String.localizedStringWithFormat(String(localized: "time.compact.days", bundle: .lody), Int(elapsed / day)) }
    let formatter = DateFormatter()
    formatter.locale = LodyFormat.locale
    formatter.timeZone = calendar.timeZone
    formatter.setLocalizedDateFormatFromTemplate("MMMd")
    return formatter.string(from: Date(timeIntervalSince1970: value / 1000))
  }

  static func text(_ value: Double, now: Double = now(), calendar: Calendar = .current) -> String {
    guard value.isFinite else { return "" }
    let elapsed = now - value
    if elapsed < minute { return String(localized: "time.justNow", bundle: .lody) }
    if elapsed < hour { return String.localizedStringWithFormat(String(localized: "time.minutesAgo", bundle: .lody), Int(elapsed / minute)) }
    let today = calendar.startOfDay(for: Date(timeIntervalSince1970: now / 1000)).timeIntervalSince1970 * 1000
    if value >= today { return String.localizedStringWithFormat(String(localized: "time.hoursAgo", bundle: .lody), Int(elapsed / hour)) }
    if value >= today - day { return String(localized: "time.yesterday", bundle: .lody) }
    let formatter = DateFormatter()
    formatter.locale = LodyFormat.locale
    formatter.timeZone = calendar.timeZone
    formatter.setLocalizedDateFormatFromTemplate("MMMd")
    return formatter.string(from: Date(timeIntervalSince1970: value / 1000))
  }
}

enum LodyFormat {
  static var locale: Locale { Locale(identifier: Bundle.main.preferredLocalizations.first ?? "en") }
}
