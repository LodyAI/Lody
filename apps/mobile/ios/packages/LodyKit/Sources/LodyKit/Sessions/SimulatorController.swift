import UIKit

@MainActor
final class SimulatorController: UIViewController {
  private let store: SessionSimulator
  private let simulator = LodySimulatorView(frame: .zero)
  private let notice = UIContentUnavailableView(configuration: .empty())
  private var command = 0

  init(store: SessionSimulator) { self.store = store; super.init(nibName: nil, bundle: nil) }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyBackground
    for child in [simulator, notice] as [UIView] {
      child.frame = view.bounds; child.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(child)
    }
    store.watch(self) { [weak self] in self?.render() }
    render()
  }
  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    if let parent { simulator.adoptZoomTransition(on: parent) }
    if isViewLoaded { render() }
  }
  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if navigationController == nil { simulator.returnToPreview() }
  }
  private func render() {
    let source = store.sourceJSON
    simulator.setSource(source); simulator.isHidden = source.isEmpty; notice.isHidden = !source.isEmpty
    if source.isEmpty {
      var configuration = UIContentUnavailableConfiguration.empty()
      configuration.text = store.phaseText
      configuration.secondaryText = store.message
      notice.configuration = configuration
    }
    parent?.navigationItem.title = store.name
    let home = UIBarButtonItem(image: UIImage(systemName: "house"), primaryAction: UIAction { [weak self] _ in self?.run("home") })
    home.accessibilityLabel = String(localized: "simulator.action.home", bundle: .lody); home.isEnabled = !source.isEmpty
    if store.platform == .android { return renderAndroid(source.isEmpty, home: home) }
    let groups = [
      [("app-switcher", "appSwitcher", "square.stack"), ("lock", "lock", "lock")],
      [("rotate-left", "rotateLeft", "rotate.left"), ("rotate-right", "rotateRight", "rotate.right"), ("shake", "shake", "iphone.radiowaves.left.and.right")],
      [("volume-up", "volumeUp", "speaker.plus"), ("volume-down", "volumeDown", "speaker.minus"), ("action", "actionButton", "button.programmable")],
    ]
    var menus: [UIMenuElement] = groups.map { group in
      UIMenu(options: .displayInline, children: group.map { id, key, symbol in
        UIAction(title: String(localized: String.LocalizationValue("simulator.action." + key), bundle: .lody), image: UIImage(systemName: symbol), attributes: source.isEmpty ? .disabled : []) { [weak self] _ in self?.run(id) }
      })
    }
    menus.append(lifecycleMenu())
    let menu = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: menus))
    menu.accessibilityLabel = String(localized: "common.more", bundle: .lody)
    parent?.navigationItem.rightBarButtonItems = [menu, home]
  }
  /// Android: Back and Home in the bar; Recents, rotation, appearance, paste and quality in More.
  private func renderAndroid(_ empty: Bool, home: UIBarButtonItem) {
    let back = UIBarButtonItem(image: UIImage(systemName: "arrow.uturn.backward"), primaryAction: UIAction { [weak self] _ in self?.run("back") })
    back.accessibilityLabel = String(localized: "simulator.action.back", bundle: .lody); back.isEnabled = !empty
    let disabled: UIMenuElement.Attributes = empty ? .disabled : []
    func action(_ key: String, _ symbol: String, _ id: String) -> UIAction {
      UIAction(title: String(localized: String.LocalizationValue(key), bundle: .lody), image: UIImage(systemName: symbol), attributes: disabled) { [weak self] _ in self?.run(id) }
    }
    let quality = UIMenu(title: String(localized: "simulator.quality.label", bundle: .lody), image: UIImage(systemName: "slider.horizontal.3"),
      children: DevicePreviewQuality.allCases.map { tier in
        UIAction(title: String(localized: String.LocalizationValue("simulator.quality." + tier.rawValue), bundle: .lody),
          attributes: empty ? .disabled : [], state: store.quality == tier ? .on : .off) { [weak self] _ in self?.store.setQuality(tier) }
      })
    let menus: [UIMenuElement] = [
      UIMenu(options: .displayInline, children: [action("simulator.action.recents", "square.on.square", "app-switcher")]),
      UIMenu(options: .displayInline, children: [
        action("simulator.action.rotateLeft", "rotate.left", "rotate-left"), action("simulator.action.rotateRight", "rotate.right", "rotate-right"),
      ]),
      UIMenu(options: .displayInline, children: [
        UIMenu(title: String(localized: "simulator.action.appearance", bundle: .lody), image: UIImage(systemName: "circle.lefthalf.filled"), children: [
          action("simulator.appearance.light", "sun.max", "appearance-light"), action("simulator.appearance.dark", "moon", "appearance-dark"),
        ]),
        UIAction(title: String(localized: "simulator.action.pasteText", bundle: .lody), image: UIImage(systemName: "doc.on.clipboard"), attributes: disabled) { [weak self] _ in self?.pasteText() },
        quality,
      ]),
      lifecycleMenu(),
    ]
    let menu = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: menus))
    menu.accessibilityLabel = String(localized: "common.more", bundle: .lody)
    parent?.navigationItem.rightBarButtonItems = [menu, home, back]
  }
  private func lifecycleMenu() -> UIMenu {
    let android = store.platform == .android
    return UIMenu(options: .displayInline, children: [
      UIAction(title: String(localized: String.LocalizationValue(android ? "emulator.chooseAnother" : "simulator.chooseAnother"), bundle: .lody),
        image: UIImage(systemName: android ? "smartphone" : "iphone.gen3")) { [weak self] _ in
        guard let self else { return }
        let picker = SimulatorPickerController(store: store) { [weak self] device in self?.store.start(device) }
        LodyShell.shared.presentNative(picker, title: String(localized: String.LocalizationValue(android ? "emulator.choose" : "simulator.choose"), bundle: .lody), grabber: true)
      },
      UIAction(title: String(localized: "simulator.stop", bundle: .lody), image: UIImage(systemName: "stop.circle"), attributes: .destructive) { [weak self] _ in self?.stop() },
    ])
  }
  /// The text is typed into the emulator's focused field; nothing is read from the pasteboard
  /// until the person pastes into this field.
  private func pasteText() {
    let alert = UIAlertController(title: String(localized: "simulator.action.pasteText", bundle: .lody),
      message: String(localized: "simulator.pasteText.message", bundle: .lody), preferredStyle: .alert)
    alert.addTextField()
    alert.addAction(UIAlertAction(title: String(localized: "common.cancel", bundle: .lody), style: .cancel))
    alert.addAction(UIAlertAction(title: String(localized: "simulator.pasteText.send", bundle: .lody), style: .default) { [weak self, weak alert] _ in
      guard let text = alert?.textFields?.first?.text, !text.isEmpty else { return }
      self?.run("text", text: text)
    })
    present(alert, animated: true)
  }
  private func run(_ action: String, text: String? = nil) {
    command += 1
    var body: [String: Any] = ["token": command, "action": action]
    if let text { body["text"] = text }
    simulator.setCommand(SessionController.json(body))
  }
  private func stop() {
    Task { [weak self] in
      guard let self else { return }
      do { try await store.stop(); SettingsPage.pop(self) }
      catch { LodyToastOverlay.shared.show(message: error.localizedDescription, kind: .error) }
    }
  }
}

@MainActor
final class SimulatorPickerController: UIViewController {
  private let store: SessionSimulator
  private let selected: (SessionSimulator.Device) -> Void
  private let list = LodyGroupedList(frame: .zero)
  private var devices: [SessionSimulator.Device] = []
  private var error = ""
  private var task: Task<Void, Never>?
  init(store: SessionSimulator, selected: @escaping (SessionSimulator.Device) -> Void) {
    self.store = store; self.selected = selected; super.init(nibName: nil, bundle: nil)
  }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
  isolated deinit { task?.cancel() }
  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in
      guard name == "rowPress", let self, let id = body["id"] as? String else { return }
      if id == "retry" { load(); return }
      guard let device = devices.first(where: { $0.id == id }), device.available, !device.occupied else { return }
      navigationController?.dismiss(animated: true) { [selected] in selected(device) }
    }
    load()
  }
  private func load() {
    task?.cancel(); error = ""; list.setLoading(true)
    task = Task { [weak self, store] in
      do {
        let devices = try await store.devices()
        guard !Task.isCancelled, let self else { return }
        self.devices = devices
      } catch {
        guard !Task.isCancelled, let self else { return }
        self.error = error.localizedDescription
      }
      self?.render()
    }
  }
  private func render() {
    list.setLoading(false)
    var sections: [LodyListSection] = []
    if !error.isEmpty {
      var section = LodyListSection(); section.id = "error"; section.footer = error
      var retry = LodyListRow(); retry.id = "retry"; retry.title = String(localized: "common.retry", bundle: .lody); retry.action = true
      section.rows = [retry]; sections.append(section)
    }
    let android = store.platform == .android
    if error.isEmpty, devices.isEmpty {
      var section = LodyListSection(); section.id = "empty"
      var row = LodyListRow(); row.id = "empty"
      row.title = String(localized: String.LocalizationValue(android ? "emulator.empty" : "simulator.empty"), bundle: .lody)
      section.rows = [row]; sections.append(section)
    }
    for key in ["booted", "shutdown", "unavailable"] {
      let group = devices.filter { device in
        if !device.available { return key == "unavailable" }
        return key == (device.state == "Booted" ? "booted" : "shutdown")
      }
      guard !group.isEmpty else { continue }
      var section = LodyListSection(); section.id = key; section.header = String(localized: String.LocalizationValue("simulator.section." + key), bundle: .lody)
      section.rows = group.map { device in
        var row = LodyListRow(); row.id = device.id; row.title = device.name; row.subtitle = device.runtime
        if android { row.image = "smartphone" } else { row.image = device.deviceType.hasPrefix("iPad") ? "ipad" : "iphone" }
        row.value = String(localized: String.LocalizationValue(device.state == "Booted" ? "simulator.device.preview" : "simulator.device.boot"), bundle: .lody)
        if device.occupied { row.value = String(localized: "simulator.device.occupied", bundle: .lody) }
        if !device.available { row.value = device.unavailableReason ?? "" }
        row.action = device.available && !device.occupied
        return row
      }
      sections.append(section)
    }
    list.setSections(sections)
  }
}
