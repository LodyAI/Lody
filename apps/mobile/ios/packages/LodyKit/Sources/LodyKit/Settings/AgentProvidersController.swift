import LodyCore
import UIKit

struct AgentProviderRequest: Encodable, Sendable {
  var workspaceId: String
  var action: String
  var machineId: String?
  var id: String?
  var setup: AgentProviderSetup?
  var base: AgentProviderItem?
  var fields: AgentProviderFields?

  private enum CodingKeys: String, CodingKey { case workspaceId, action, machineId, id, setup, base, fields }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(workspaceId, forKey: .workspaceId)
    try values.encode(action, forKey: .action)
    try values.encodeIfPresent(machineId, forKey: .machineId)
    try values.encodeIfPresent(id, forKey: .id)
    try values.encodeIfPresent(setup, forKey: .setup)
    if let base { try values.encode(base, forKey: .base) }
    else if action == "save" { try values.encodeNil(forKey: .base) }
    try values.encodeIfPresent(fields, forKey: .fields)
  }
}

typealias AgentProviderService = @MainActor (AgentProviderRequest) async throws -> AgentProviderSnapshot

@MainActor
final class AgentProvidersController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  private let scope: SettingsActor
  private let service: AgentProviderService
  private let details: ProviderDetailService
  private var snapshot: AgentProviderSnapshot?
  private var selectedID: String?
  private var loading = false
  private var failed = false
  private var busy = false
  private var generation = 0
  private var loadedAt: Double?
  private var observer: NSObjectProtocol?
  private var providersObserver: NSObjectProtocol?
  private var pendingMachines: Set<String> = []
  /// Whether the shown list came from a live read this session; a cached list never authorizes writes.
  private var live = false
  private var store: SettingsSnapshotStore<AgentProviderSnapshot> {
    SettingsSnapshotStore(kind: "agent-providers", userId: scope.userId, workspaceId: scope.workspaceId)
  }

  init(scope: SettingsActor, service: @escaping AgentProviderService = AgentProvidersController.cloud, details: ProviderDetailService = .cloud) {
    self.scope = scope
    self.service = service
    self.details = details
    super.init(nibName: nil, bundle: nil)
    title = RemoteSettingsSections.remote("agent")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    if let providersObserver { NotificationCenter.default.removeObserver(providersObserver) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    scope.watch(self) { [weak self] in
      guard let self else { return }
      self.generation += 1
      self.pendingMachines.removeAll()
      self.snapshot = nil
      self.selectedID = nil
      self.busy = false
      self.loading = false
      self.loadedAt = nil
      self.live = false
      self.restoreThenRefresh()
    }
    providersObserver = NotificationCenter.default.addObserver(forName: .lodyProvidersChanged, object: nil, queue: .main) { [weak self] notification in
      guard let event = notification.object as? RuntimeContract.AgentProvidersChangedEvent else { return }
      let eventScope = notification.userInfo?["scopeKey"] as? String
      MainActor.assumeIsolated {
        guard let self, self.scope.valid, eventScope == self.scope.key else { return }
        self.pendingMachines.insert(event.machineId)
        self.render()
      }
    }
    observer = NotificationCenter.default.addObserver(forName: .lodyCatalogDidChange, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.viewIfLoaded?.window != nil, !self.loading, !self.busy else { return }
        self.refresh()
      }
    }
    restoreThenRefresh()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    renderHeader()
  }

  /// Shows the last accepted list at once, then reads the live one behind it.
  private func restoreThenRefresh() {
    let key = scope.key, store = store, version = generation
    guard scope.valid else { return refresh() }
    Task { [weak self] in
      let cached = await store.read()
      guard let self, self.scope.key == key, self.generation == version else { return }
      if let cached, self.snapshot == nil {
        self.snapshot = cached
        self.selectedID = AgentProviderSections.selected(cached, id: self.selectedID)?.id
      }
      self.refresh()
    }
  }

  private var machine: AgentProviderMachine? {
    snapshot.flatMap { AgentProviderSections.selected($0, id: selectedID) }
  }

  private func refresh(machineID: String? = nil) {
    guard !busy else { return }
    generation += 1
    let version = generation, key = scope.key
    guard scope.valid else {
      failed = true
      loading = false
      render()
      return
    }
    loading = true
    failed = false
    render()
    let request = AgentProviderRequest(workspaceId: scope.workspaceId, action: "list", machineId: machineID)
    Task { [weak self, service] in
      do {
        let next = try await service(request)
        guard let self, self.generation == version, self.scope.key == key else { return }
        self.loading = false
        if let machineID { self.accept(AgentProviderSections.merging(next, into: self.snapshot, machineID: machineID)) }
        else { self.accept(next) }
        self.render()
      } catch {
        guard let self, self.generation == version, self.scope.key == key else { return }
        self.loading = false
        self.failed = true
        self.render()
      }
    }
  }

  private func accept(_ next: AgentProviderSnapshot) {
    snapshot = next
    selectedID = AgentProviderSections.selected(next, id: selectedID)?.id
    loadedAt = LodyRelativeTime.now()
    failed = false
    live = true
    var saved = next
    saved.authRequired = nil
    store.write(saved)
  }

  private func render() {
    guard isViewLoaded else { return }
    if !busy, !loading, !failed, let changedMachine = pendingMachines.sorted().first {
      pendingMachines.remove(changedMachine)
      refresh(machineID: changedMachine)
      return
    }
    SettingsPage.apply(LodyListState.make(
      title: String(localized: "settings.unavailable.agent", bundle: .lody), hasData: snapshot != nil,
      loading: loading, failed: failed, syncedAt: loadedAt
    ), to: list)
    list.setRefreshing(false)
    list.setPlaceholder(snapshot?.machines.isEmpty == true ? AgentProviderSections.text("noMachines") : "")
    list.setSections(snapshot.map { AgentProviderSections.make($0, selectedID: selectedID, busy: busy || !live, usage: RemoteSettingsContext.current().agentUsage) } ?? [])
    renderHeader()
  }

  private func renderHeader() {
    let add = LodyFormController.barButton(symbol: "plus", label: AgentProviderSections.text("add")) { [weak self] in
      self?.edit(nil)
    }
    add.accessibilityIdentifier = "provider-add"
    add.isEnabled = live && !busy && machine.map { !$0.readOnly && $0.online } == true
    parent?.navigationItem.rightBarButtonItems = [add]
  }

  private func event(_ name: String, _ body: [String: Any]) {
    if ["refresh", "noticeAction", "unavailableAction"].contains(name) { refresh(); return }
    guard let id = body["id"] as? String else { return }
    if name == "rowPress", id == "provider-machine-picker" { pickMachine(); return }
    guard !busy, let machine else { return }
    if let item = snapshot?.providers.first(where: { "provider:\($0.id)" == id && $0.machineId == machine.id }) {
      let action = name == "rowAction" ? body["actionId"] as? String : "edit"
      switch action {
      case "edit": edit(item)
      case "delete" where live && !item.readOnly && !machine.readOnly:
        confirmDelete(name: item.name) { [weak self] in self?.mutate("delete", item: item) }
      case "refresh" where live && machine.online && !item.readOnly && !machine.readOnly:
        mutate("refresh", item: item)
      default: break
      }
    } else if let setup = snapshot?.setups.first(where: { "provider-setup:\($0.id)" == id && $0.machineId == machine.id }) {
      if name == "rowAction", body["actionId"] as? String == "deleteSetup", setup.canDelete {
        confirmDelete(name: setup.name) { [weak self] in self?.mutate("deleteSetup", setup: setup) }
      } else if setup.status == "awaiting-auth", machine.online, !machine.readOnly, machine.supportsAuthentication == true {
        let target = ProviderTarget(workspaceId: scope.workspaceId, machineId: machine.id, id: setup.id)
        let controller = AgentProviderAuthController(target: target, methods: [], scope: scope, service: details)
        controller.authenticated = { [weak self] in self?.refresh() }
        LodyShell.shared.presentNative(controller, title: setup.name, detents: [1])
      } else if setup.canRetry { mutate("retrySetup", setup: setup) }
    }
  }

  private func pickMachine() {
    guard let snapshot else { return }
    let key = scope.key
    let picker = AgentProviderMachinePicker(machines: snapshot.machines, selectedID: machine?.id) { [weak self] id in
      guard let self, self.scope.key == key, self.snapshot?.machines.contains(where: { $0.id == id }) == true else { return }
      self.selectedID = id
      self.render()
    }
    LodyShell.shared.presentNative(picker, title: AgentProviderSections.text("machines"), detents: [0.5, 1])
  }

  private func edit(_ item: AgentProviderItem?) {
    guard let machine, !busy else { return }
    if item == nil && (!live || machine.readOnly || !machine.online) { return }
    let key = scope.key
    let editor = AgentProviderEditorController(machine: machine, item: item, catalog: (snapshot?.catalog ?? []).filter { $0.cliType != "custom" && (machine.supportsSetup || $0.cliType != "builtin" || $0.agentType == "deepseek") } + [AgentProviderCatalogItem(id: "custom", name: AgentProviderSections.text("custom"), cliType: "custom", agentType: "custom")], scope: scope, service: service, details: details, presets: snapshot?.presets ?? [])
    editor.willSave = { [weak self] provisional in
      guard let self, self.scope.key == key, var current = self.snapshot else { return }
      // Shown at once; the editor's reply (or a fresh read after a failure) replaces it.
      current.providers.removeAll { $0.id == provisional.id && $0.machineId == provisional.machineId }
      current.providers.append(provisional)
      self.snapshot = current
      self.render()
    }
    editor.saveFailed = { [weak self] in
      guard let self, self.scope.key == key else { return }
      self.refresh()
    }
    editor.deleteRequested = { [weak self] target in
      guard let self, self.scope.key == key else { return }
      self.mutate("delete", item: target)
    }
    editor.saved = { [weak self] next in
      guard let self, self.scope.key == key else { return }
      self.generation += 1
      self.accept(AgentProviderSections.merging(next, into: self.snapshot, machineID: machine.id))
      self.render()
    }
    LodyShell.shared.presentNative(editor, title: AgentProviderSections.text(item == nil ? "add" : "edit"), detents: [1])
  }

  private func confirmDelete(name: String, perform: @escaping @MainActor () -> Void) {
    let key = scope.key
    SettingsPage.confirm(from: self, title: AgentProviderSections.text("delete"), message: String.localizedStringWithFormat(
      AgentProviderSections.text("deleteConfirm"), name
    ), action: AgentProviderSections.text("delete"), destructive: true) { [weak self] in
      guard let self, self.scope.key == key else { return }
      perform()
    }
  }

  private func mutate(_ action: String, item: AgentProviderItem? = nil, setup: AgentProviderSetup? = nil) {
    guard !busy, live, let machine, !machine.readOnly else { return }
    generation += 1
    let version = generation, key = scope.key
    let previous = snapshot
    if action == "delete", let item, var current = snapshot {
      current.providers.removeAll { $0.id == item.id && $0.machineId == item.machineId }
      snapshot = current
    } else if action == "deleteSetup", let setup, var current = snapshot {
      current.setups.removeAll { $0.id == setup.id && $0.machineId == setup.machineId }
      snapshot = current
    }
    busy = true
    render()
    let request = AgentProviderRequest(workspaceId: scope.workspaceId, action: action, machineId: machine.id,
                                       setup: setup, base: item)
    Task { [weak self, service] in
      do {
        let next = try await service(request)
        guard let self, self.generation == version, self.scope.key == key else { return }
        self.busy = false
        self.accept(AgentProviderSections.merging(next, into: self.snapshot, machineID: machine.id))
        self.render()
        if next.authRequired == true {
          LodyToastOverlay.shared.show(message: AgentProviderSections.text("authRequired"), kind: .warning)
        }
      } catch {
        guard let self, self.generation == version, self.scope.key == key else { return }
        self.busy = false
        // Roll the optimistic change back, then read again: the write may still have landed.
        self.snapshot = previous
        LodyToastOverlay.shared.show(message: AgentProviderSections.text("writeFailed"), kind: .error)
        self.render()
        self.refresh()
      }
    }
  }

  static func cloud(_ request: AgentProviderRequest) async throws -> AgentProviderSnapshot {
    try await DataRuntime.settingsCall(RuntimeContract.Calls.AgentProviders.self, request, as: AgentProviderSnapshot.self)
  }
}

@MainActor
private final class AgentProviderMachinePicker: UIViewController {
  private let machines: [AgentProviderMachine]
  private let selectedID: String?
  private let choose: (String) -> Void

  init(machines: [AgentProviderMachine], selectedID: String?, choose: @escaping (String) -> Void) {
    self.machines = machines
    self.selectedID = selectedID
    self.choose = choose
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    let list = LodyGroupedList(frame: .zero)
    SettingsPage.host(list, in: self) { [weak self] name, body in
      guard let self, name == "rowPress", let id = body["id"] as? String,
            let machine = self.machines.first(where: { "provider-machine:\($0.id)" == id }) else { return }
      self.choose(machine.id)
      self.dismiss(animated: true)
    }
    list.setSections(AgentProviderSections.picker(machines, selectedID: selectedID))
  }
}
