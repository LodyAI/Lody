import UIKit

@MainActor
final class PreferencesController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private var observers: [NSObjectProtocol] = []

  init() {
    super.init(nibName: nil, bundle: nil)
    title = text("preferences.title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    view.addSubview(list)
    for name in [Notification.Name.lodyPreferencesDidChange, .lodyAppearanceDidChange, UIApplication.didBecomeActiveNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      })
    }
    render()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    render()
  }

  private func appIconRow() -> LodyListRow {
    let icon = LodyAppIcon.current
    let value = icon == "Aqua" ? "Aqua" : text("preferences.defaultIcon")
    var row = LodyListRow.item(
      "app-icon", text("preferences.appIcon"), value: value, imageAsset: "AppIconPreview-\(icon)", disclosure: true,
      navigates: true, accessibilityValue: value
    )
    row.imageOriginal = true
    return row
  }

  private func render() {
    let language = text("preferences.languageName")
    let current = LodyPreferences.queuedMessageBehavior
    var queued = LodyListRow.item(
      "queued-message-behavior", text("queuedMessageBehavior.title"), value: text("queuedMessageBehavior.\(current)"),
      image: "arrow.uturn.forward"
    )
    queued.options = ["queue", "guide"].map { option($0, text("queuedMessageBehavior.\($0)"), selected: $0 == current) }
    list.setSections([
      .group("general", header: text("preferences.general"), [
        .item(
          "language", text("preferences.language"), value: language, image: "globe", disclosure: true,
          accessibilityValue: language
        ),
        .item("notifications", text("notifications.title"), image: "bell", disclosure: true, navigates: true),
      ]),
      .group("chat", header: text("preferences.chat"), [
        queued,
      ]),
      .group("appearance", header: text("preferences.appearance"), [appIconRow()]),
    ])
  }

  private func event(_ name: String, _ body: [String: Any]) {
    guard let id = body["id"] as? String else { return }
    switch (name, id, body["actionId"] as? String) {
    case ("rowAction", "queued-message-behavior", let value?) where ["queue", "guide"].contains(value):
      LodyPreferences.saveQueuedMessageBehavior(value)
    case ("rowPress", "app-icon", _):
      LodyShell.shared.pushNative("app-icon", title: text("preferences.appIcon"), from: self)
    case ("rowPress", "language", _):
      openLanguageSettings()
    case ("rowPress", "notifications", _):
      LodyShell.shared.openPage("notification-settings", from: self)
    default:
      break
    }
  }

  private func openLanguageSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url) { opened in
      guard !opened else { return }
      LodyToastOverlay.shared.show(message: String(localized: "settings.preferences.languageFailed", bundle: .lody), kind: .error)
    }
  }

  private func option(_ id: String, _ title: String, selected: Bool) -> LodyListAction {
    var action = LodyListAction()
    action.id = id
    action.title = title
    action.selected = selected
    return action
  }

  private func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings." + key), bundle: .lody) }
}
