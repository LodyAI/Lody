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
    view.backgroundColor = .systemBackground
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
    menus.append(UIMenu(options: .displayInline, children: [
      UIAction(title: String(localized: "simulator.chooseAnother", bundle: .lody), image: UIImage(systemName: "iphone.gen3")) { [weak self] _ in
        guard let self else { return }
        let picker = SimulatorPickerController(store: store) { [weak self] device in self?.store.start(device) }
        LodyShell.shared.presentNative(picker, title: String(localized: "simulator.choose", bundle: .lody), grabber: true)
      },
      UIAction(title: String(localized: "simulator.stop", bundle: .lody), image: UIImage(systemName: "stop.circle"), attributes: .destructive) { [weak self] _ in self?.stop() },
    ]))
    let menu = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: menus))
    menu.accessibilityLabel = String(localized: "common.more", bundle: .lody)
    parent?.navigationItem.rightBarButtonItems = [menu, home]
  }
  private func run(_ action: String) {
    command += 1
    simulator.setCommand(SessionController.json(["token": command, "action": action]))
  }
  private func stop() {
    Task { [weak self] in
      guard let self else { return }
      do { try await store.stop(); SettingsPage.pop(self) }
      catch { LodyToastOverlay.shared.show(message: error.localizedDescription, kind: "error") }
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
      guard let device = devices.first(where: { $0.udid == id }), device.available, device.occupancy != .otherSession else { return }
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
    for key in ["booted", "shutdown", "unavailable"] {
      let group = devices.filter { device in
        if !device.available { return key == "unavailable" }
        return key == (device.state == "Booted" ? "booted" : "shutdown")
      }
      guard !group.isEmpty else { continue }
      var section = LodyListSection(); section.id = key; section.header = String(localized: String.LocalizationValue("simulator.section." + key), bundle: .lody)
      section.rows = group.map { device in
        var row = LodyListRow(); row.id = device.udid; row.title = device.name; row.subtitle = device.runtime
        row.image = device.deviceType.hasPrefix("iPad") ? "ipad" : "iphone"
        row.value = String(localized: String.LocalizationValue(device.state == "Booted" ? "simulator.device.preview" : "simulator.device.boot"), bundle: .lody)
        if device.occupancy == .otherSession { row.value = String(localized: "simulator.device.occupied", bundle: .lody) }
        if !device.available { row.value = device.unavailableReason ?? "" }
        row.action = device.available && device.occupancy != .otherSession
        return row
      }
      sections.append(section)
    }
    list.setSections(sections)
  }
}
