import LodyCore
import UIKit

@MainActor
class MemorySettingsController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  let scope: SettingsActor
  private let service: MemoryService
  private var workspace = ""
  private var machineId: String?
  private var snapshot: MemorySnapshot?
  private var loading = true
  private var failed = false
  private var failure = ""
  private var uncertain = false
  private var syncedAt: Double?
  private var generation = 0
  private var writing = false

  init(scope: SettingsActor, service: @escaping MemoryService = MemorySettingsController.cloud) {
    self.scope = scope
    self.service = service
    super.init(nibName: nil, bundle: nil)
    title = MemorySections.text("title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    scope.watch(self) { [weak self] in
      guard let self else { return }
      self.generation += 1
      self.scopeDidChange()
    }
    reset()
  }

  func scopeDidChange() { reset() }

  private func reset() {
    workspace = scope.valid ? scope.workspaceId : ""
    machineId = nil
    snapshot = nil
    failed = false
    failure = ""
    uncertain = false
    syncedAt = nil
    refresh()
  }

  private func refresh() {
    generation += 1
    guard !workspace.isEmpty else {
      loading = false
      return render()
    }
    let id = generation
    loading = true
    failed = false
    render()
    Task { [weak self, service, workspace, machineId] in
      let result: Result<MemorySnapshot, Error>
      do { result = .success(try await service(MemoryRequest(workspaceId: workspace, machineId: machineId, action: "list"))) }
      catch { result = .failure(error) }
      guard let self, self.generation == id else { return }
      switch result {
      case .success(let next):
        self.snapshot = next
        self.syncedAt = LodyRelativeTime.now()
        self.uncertain = false
        self.failure = ""
      case .failure(let error):
        self.failed = true
        if MemoryFailure.message(error).contains("forbidden") {
          self.snapshot = nil
          self.failure = MemorySections.text("forbidden")
        }
      }
      self.loading = false
      self.render()
    }
  }

  private func importIdentity(_ memoryId: String) {
    guard let snapshot, !writing, !loading, !failed, !uncertain, !snapshot.cached, snapshot.status == "ready" else { return }
    writing = true
    loading = true
    let current = generation
    render()
    Task { [weak self, service, workspace] in
      let request = MemoryRequest(workspaceId: workspace, machineId: snapshot.machineId, action: "import", memoryId: memoryId)
      let result: Result<MemorySnapshot, Error>
      do { result = .success(try await service(request)) } catch { result = .failure(error) }
      guard let self else { return }
      self.writing = false
      guard self.generation == current else { return }
      switch result {
      case .success(let next):
        self.snapshot = next
        self.failure = ""
      case .failure(let error):
        let failure = MemoryFailure(error)
        if let status = failure.status {
          self.snapshot?.status = status
          self.snapshot?.identities = []
        }
        self.failure = failure.text
        self.uncertain = failure.uncertain
      }
      self.loading = false
      self.render()
    }
  }

  private func render() {
    let state = LodyListState.make(
      title: MemorySections.text("unavailable"), hasData: snapshot != nil, loading: loading, failed: failed,
      unconfirmed: uncertain, partial: snapshot?.cached == true ? MemorySections.text("cached") : nil, syncedAt: syncedAt
    )
    list.setLoading(state.loading)
    if var unavailable = state.unavailable, !failure.isEmpty {
      unavailable.message = failure
      list.setUnavailable(unavailable)
    } else {
      list.setUnavailable(state.unavailable)
    }
    if !failure.isEmpty, state.unavailable == nil {
      list.setNotice(MemorySections.warning(failure, refresh: true))
    } else {
      list.setNotice(state.notice)
    }
    list.setRefreshing(loading && snapshot != nil)
    list.setPlaceholder(snapshot?.machines.isEmpty == true ? MemorySections.text("noMachines") : "")
    list.setSections(MemorySections.list(snapshot, loading: loading, failed: failed, uncertain: uncertain))
  }

  private func event(_ name: String, _ body: [String: Any]) {
    switch name {
    case "refresh", "noticeAction":
      if !writing { refresh() } else { render() }
    case "unavailableAction":
      refresh()
    case "rowPress":
      guard let id = body["id"] as? String else { return }
      press(id)
    default:
      break
    }
  }

  private func press(_ id: String) {
    guard let snapshot, !loading else { return }
    if id.hasPrefix("machine:"), String(id.dropFirst(8)) != snapshot.machineId {
      generation += 1
      self.snapshot = nil
      failure = ""
      uncertain = false
      machineId = String(id.dropFirst(8))
      refresh()
    }
    if id == "provider-install", let url = URL(string: "https://mem.nowledge.co/en") {
      UIApplication.shared.open(url)
    }
    if id.hasPrefix("import:") {
      let memoryId = String(id.dropFirst(7))
      SettingsPage.confirm(
        from: self, title: MemorySections.text("import"), message: MemorySections.text("importConfirm"),
        action: MemorySections.text("import"), destructive: false
      ) { [weak self] in self?.importIdentity(memoryId) }
    }
    guard let item = snapshot.entries.first(where: { "saved:\(MemorySections.entryId($0))" == id }) else { return }
    var shown = snapshot
    shown.cached = snapshot.cached || failed
    let current = generation
    let detail = MemoryDetailController(
      scope: scope, workspaceId: workspace, item: item, snapshot: shown, service: service
    ) { [weak self] completed in
      guard let self, completed, self.generation == current else { return }
      self.refresh()
    }
    LodyShell.shared.pushNative(detail, title: MemorySections.text("details"), from: self)
  }

  static func cloud(_ request: MemoryRequest) async throws -> MemorySnapshot {
    try await DataRuntime.settingsCall(RuntimeContract.Calls.MemorySettings.self, request, as: MemorySnapshot.self)
  }
}
