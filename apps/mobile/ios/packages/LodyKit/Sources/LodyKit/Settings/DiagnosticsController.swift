import UIKit

@MainActor
struct DiagnosticsService {
  var count: (Int) async throws -> Int
  var share: (Int, UIViewController) async throws -> Void
  var clear: () async throws -> Void

  static var local: DiagnosticsService {
    DiagnosticsService(
      count: { window in try await Task.detached { try DiagnosticsStore.shared.count(since: Double(window)) }.value },
      share: { window, controller in
        let file = try await Task.detached { try DiagnosticsStore.shared.export(since: Double(window)) }.value
        guard controller.viewIfLoaded?.window != nil, controller.presentedViewController == nil else {
          try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
          throw CocoaError(.userCancelled)
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
          DiagnosticsSharing.present(file, from: controller) { error in
            if let error { continuation.resume(throwing: error) } else { continuation.resume() }
          }
        }
      },
      clear: { try await Task.detached { try DiagnosticsStore.shared.clear() }.value }
    )
  }
}

@MainActor
class DiagnosticsController: UIViewController {
  enum Message: String { case readFailed, exportFailed, clearFailed, cleared }

  static let ranges = [900, 3600, 86400, 604800]
  private static let rangeKeys = [900: "quarterHour", 3600: "hour", 86400: "day", 604800: "week"]

  let list = LodyGroupedList(frame: .zero)
  var service: DiagnosticsService
  private var range = 3600
  private var count: Int?
  private var working = false
  private var message: Message?
  private var request = 0
  private var observer: NSObjectProtocol?

  init(service: DiagnosticsService = .local) {
    self.service = service
    super.init(nibName: nil, bundle: nil)
    title = Self.text("title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in self?.event(name, body) }
    list.setPlaceholder("")
    observer = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
    begin()
  }

  func begin() { restart() }

  func remount() {
    range = 3600
    restart()
  }

  func restart() {
    message = nil
    refresh()
  }

  private func refresh() {
    Task { await load() }
  }

  private func load() async {
    request += 1
    let id = request
    count = nil
    render()
    do {
      let next = try await service.count(range)
      guard request == id else { return }
      count = next
      if message == .readFailed { message = nil }
    } catch {
      guard request == id else { return }
      message = .readFailed
    }
    render()
  }

  private func perform(clear: Bool) {
    guard !working else { return }
    working = true
    message = nil
    render()
    Task {
      do {
        if clear {
          try await service.clear()
          message = .cleared
          await load()
        } else {
          try await service.share(range, self)
        }
      } catch {
        message = clear ? .clearFailed : .exportFailed
      }
      working = false
      render()
    }
  }

  private func event(_ name: String, _ body: [String: Any]) {
    guard let id = body["id"] as? String, !working else { return }
    switch (name, id) {
    case ("rowAction", "diagnostics-range"):
      guard let next = (body["actionId"] as? String).flatMap(Int.init), Self.ranges.contains(next), next != range else { return }
      range = next
      restart()
    case ("rowPress", "diagnostics-export") where count != nil:
      perform(clear: false)
    case ("rowPress", "diagnostics-retry"):
      restart()
    case ("rowPress", "diagnostics-clear"):
      SettingsPage.confirm(
        from: self, title: Self.text("confirmTitle"), message: Self.text("confirmHint"),
        action: Self.text("confirm"), destructive: true
      ) { [weak self] in self?.perform(clear: true) }
    default:
      break
    }
  }

  private func render() {
    var countTitle = Self.text("reading")
    if let count { countTitle = String.localizedStringWithFormat(String(localized: "diagnostics.events", bundle: .lody), count) }
    else if message == .readFailed { countTitle = "—" }
    let busy = Self.text("working")
    var rangeRow = LodyListRow.item(
      "diagnostics-range", Self.text("range.title"), value: Self.rangeText(range), action: !working
    )
    rangeRow.options = Self.ranges.map { SettingsText.option(String($0), Self.rangeText($0), selected: $0 == range) }
    var clearRow = LodyListRow.item("diagnostics-clear", working ? busy : Self.text("clear"), action: !working)
    clearRow.destructive = true
    var clearSection = LodyListSection.group("diagnostics-clear-section", footer: Self.text("retention"), [clearRow])
    var sections: [LodyListSection] = [
      .group("diagnostics-export-section", footer: Self.text("exportHint"), [
        rangeRow,
        Self.icon("diagnostics-count", countTitle, "clock", "secondary"),
        Self.icon(
          "diagnostics-export", working ? busy : Self.text("export"), "square.and.arrow.up", "systemBlue",
          action: count != nil && !working
        ),
      ]),
      .group("diagnostics-included-section", header: Self.text("included"), [
        Self.icon("diagnostics-versions", Self.text("versions"), "checkmark", "systemBlue"),
        Self.icon("diagnostics-events", Self.text("eventInfo"), "checkmark", "systemBlue"),
        Self.icon("diagnostics-correlations", Self.text("correlations"), "checkmark", "systemBlue"),
      ]),
      .group("diagnostics-excluded-section", header: Self.text("excluded"), [
        Self.icon("diagnostics-content", Self.text("content"), "nosign", "secondary"),
        Self.icon("diagnostics-credentials", Self.text("credentials"), "nosign", "secondary"),
      ]),
    ]
    if let message {
      let failed = message != .cleared
      let feedback = Self.icon(
        "diagnostics-message", Self.text(message.rawValue),
        failed ? "exclamationmark.triangle" : "checkmark", failed ? "danger" : "secondary"
      )
      if message == .cleared || message == .clearFailed {
        clearSection.rows.append(feedback)
      } else {
        var rows = [feedback]
        if message == .readFailed, count == nil {
          rows.append(.item("diagnostics-retry", Self.text("retry"), action: !working))
        }
        sections.insert(.group("diagnostics-feedback", rows), at: 1)
      }
    }
    sections.append(clearSection)
    list.setSections(sections)
  }

  private static func icon(_ id: String, _ title: String, _ image: String, _ tint: String, action: Bool = false) -> LodyListRow {
    var item = LodyListRow.item(id, title, image: image, action: action)
    item.imageTint = tint
    return item
  }

  private static func rangeText(_ window: Int) -> String { text("range.\(rangeKeys[window] ?? "hour")") }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("diagnostics." + key), bundle: .lody) }
}
