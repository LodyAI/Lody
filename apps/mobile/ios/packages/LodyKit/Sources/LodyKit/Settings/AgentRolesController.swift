import LodyCore
import UIKit

@MainActor
class AgentRolesController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  let scope: SettingsScope
  private let service: AgentRoleService
  private var workspace = SettingsWorkspace()
  private var snapshot: AgentRoleSnapshot?
  private var loading = true
  private var failed = false
  private var pulled = false
  private var syncedAt: Double?
  private var version = 0
  /// Whether the shown list is from a live read; cached rows never authorize writes.
  private var live = false
  private var observer: NSObjectProtocol?
  private var store: SettingsSnapshotStore<AgentRoleSnapshot> {
    SettingsSnapshotStore(kind: "agent-roles", userId: workspace.userId, workspaceId: workspace.workspaceId)
  }

  init(scope: SettingsScope = .catalog, service: @escaping AgentRoleService = AgentRolesController.cloud) {
    self.scope = scope
    self.service = service
    super.init(nibName: nil, bundle: nil)
    title = AgentRoleSections.text("title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    view.addSubview(list)
    observer = NotificationCenter.default.addObserver(forName: scope.change, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.sync() }
    }
    sync(force: true)
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    renderHeader()
  }

  func sync(force: Bool = false) {
    let next = scope.current()
    guard force || next.key != workspace.key else { return }
    workspace = next
    snapshot = nil
    syncedAt = nil
    live = false
    version += 1
    let id = version, store = store
    Task { [weak self] in
      // The last accepted list shows at once; the live read replaces it.
      let cached = await store.read()
      guard let self, self.version == id else { return }
      if let cached, self.snapshot == nil { self.snapshot = cached }
      self.refresh()
    }
  }

  private func refresh() {
    version += 1
    let id = version
    loading = true
    failed = false
    render()
    Task { [weak self, service] in
      let next = try? await service(.list)
      guard let self, self.version == id else { return }
      if let next {
        self.accept(next)
      } else {
        self.failed = true
      }
      self.loading = false
      self.pulled = false
      self.render()
    }
  }

  private func accept(_ next: AgentRoleSnapshot) {
    snapshot = next
    syncedAt = LodyRelativeTime.now()
    live = true
    failed = false
    store.write(next)
  }

  private func render() {
    let state = LodyListState.make(
      title: AgentRoleSections.text("unavailable"), hasData: snapshot != nil, loading: loading, failed: failed,
      syncedAt: syncedAt
    )
    list.setRefreshing(pulled && loading)
    list.setLoading(state.loading)
    list.setNotice(state.notice)
    list.setUnavailable(state.unavailable)
    list.setPlaceholder(snapshot?.roles.isEmpty == true ? AgentRoleSections.text("empty") : "")
    list.setSections(snapshot.map { AgentRoleSections.make($0.roles, userId: workspace.userId) } ?? [])
    renderHeader()
  }

  private func renderHeader() {
    let add = LodyFormController.barButton(symbol: "plus", label: AgentRoleSections.text("add")) { [weak self] in
      self?.edit(nil)
    }
    add.isEnabled = live && snapshot?.agents.isEmpty == false
    parent?.navigationItem.rightBarButtonItems = [add]
  }

  private func event(_ name: String, _ body: [String: Any]) {
    switch name {
    case "rowPress":
      guard let role = snapshot?.roles.first(where: { "role:\($0.id)" == body["id"] as? String }) else { return }
      edit(role)
    case "refresh":
      pulled = true
      refresh()
    case "noticeAction", "unavailableAction":
      refresh()
    default:
      break
    }
  }

  private func edit(_ role: AgentRole?) {
    guard let snapshot else { return }
    if role == nil, !live { return }
    let key = workspace.key
    let editor = AgentRoleEditorController(
      workspace: workspace, scope: scope, role: role, agents: snapshot.agents, service: service
    )
    var previous: AgentRoleSnapshot?
    editor.willChange = { [weak self] id, next in
      guard let self, self.workspace.key == key, var current = self.snapshot else { return }
      previous = current
      // Older reads must not overwrite the optimistic row.
      self.version += 1
      self.loading = false
      if let next {
        if let index = current.roles.firstIndex(where: { $0.id == id }) { current.roles[index] = next }
        else { current.roles.append(next) }
        current.roles.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
      } else {
        current.roles.removeAll { $0.id == id }
      }
      self.snapshot = current
      self.render()
    }
    editor.failed = { [weak self] in
      guard let self, self.workspace.key == key else { return }
      if let previous { self.snapshot = previous }
      self.render()
      self.refresh()
    }
    editor.saved = { [weak self] next in
      guard let self, self.workspace.key == key else { return }
      self.version += 1
      self.loading = false
      self.accept(next)
      self.render()
    }
    LodyShell.shared.presentNative(editor, title: AgentRoleSections.text(role == nil ? "add" : "edit"))
  }

  static func cloud(_ request: AgentRoleRequest) async throws -> AgentRoleSnapshot {
    guard let runtime = DataRuntime.current else {
      throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    return try await runtime.workspaceCall(RuntimeContract.Calls.AgentRoles.self) { workspaceId, userId in
      switch request {
      case .list:
        .list(.init(workspaceId: workspaceId, userId: userId))
      case .save(let id, let base, let fields, let target):
        .save(.init(workspaceId: workspaceId, userId: userId, id: id, base: base, fields: fields, target: target))
      case .delete(let base):
        .delete(.init(workspaceId: workspaceId, userId: userId, base: base))
      }
    }
  }
}

@MainActor
struct SettingsScope {
  var change: Notification.Name
  var current: @MainActor () -> SettingsWorkspace

  static let catalog = SettingsScope(change: .lodyCatalogDidChange) { .current }
}
