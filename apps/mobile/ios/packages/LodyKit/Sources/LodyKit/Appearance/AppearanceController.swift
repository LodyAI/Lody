import UIKit

@MainActor
final class AppearanceController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private let accentPicker = AccentColorPicker()
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
    list.setSections([.group("appearance-section", header: text("title"), [darkBackgroundRow(), accentRow(), appIconRow()])])
  }

  private func darkBackgroundRow() -> LodyListRow {
    let current = LodyDarkBackground.current.rawValue
    var row = LodyListRow.item("appearance", text("darkBackground"), value: text(current), image: "circle.lefthalf.filled")
    row.options = ["soft", "black"].map { option($0, text($0), selected: $0 == current) }
    return row
  }

  private func accentRow() -> LodyListRow {
    let current = LodyAccentChoice.current
    let presets = ["ink", "blue", "indigo", "purple", "pink"]
    let preset = presets.contains(current.rawValue)
    var row = LodyListRow.item(
      "accent-color", text("accent"), value: preset ? text(current.rawValue) : text("custom"), image: "circle.fill"
    )
    row.imageTint = LodyAccentChoice.hex(current.color)
    row.options = presets.map { option($0, text($0), selected: $0 == current.rawValue) }
      + [option("custom", text("customPicker"), selected: !preset)]
    return row
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
    case ("rowAction", "appearance", let value?):
      LodyDarkBackground.save(value)
    case ("rowAction", "accent-color", "custom"):
      accentPicker.present(from: self, title: text("accent"))
    case ("rowAction", "accent-color", let value?):
      LodyAccentChoice.save(value)
    case ("rowPress", "app-icon", _):
      LodyShell.shared.pushNative("app-icon", title: text("appIcon"), from: self)
    default:
      break
    }
  }

  private func option(_ id: String, _ title: String, selected: Bool) -> LodyListAction {
    var action = LodyListAction()
    action.id = id
    action.title = title
    action.selected = selected
    return action
  }

  private func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.appearance." + key), bundle: .lody) }
}
