import UIKit

@MainActor
final class AppearanceController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private var observers: [NSObjectProtocol] = []

  init() {
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "settings.appearance.title", bundle: .lody)
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
    for name in [Notification.Name.lodyAppearanceDidChange, UIApplication.didBecomeActiveNotification] {
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

  private func render() {
    list.setSections([.group("appearance-section", header: text("title"), [appIconRow()])])
  }

  private func appIconRow() -> LodyListRow {
    let icon = LodyAppIcon.current
    let value = icon == "Aqua" ? "Aqua" : text("defaultIcon")
    var row = LodyListRow.item(
      "app-icon", text("appIcon"), value: value, imageAsset: "AppIconPreview-\(icon)", disclosure: true,
      navigates: true, accessibilityValue: value
    )
    row.imageOriginal = true
    return row
  }

  private func event(_ name: String, _ body: [String: Any]) {
    guard let id = body["id"] as? String else { return }
    switch (name, id, body["actionId"] as? String) {
    case ("rowPress", "app-icon", _):
      LodyShell.shared.pushNative("app-icon", title: text("appIcon"), from: self)
    default:
      break
    }
  }

  private func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.appearance." + key), bundle: .lody) }
}
