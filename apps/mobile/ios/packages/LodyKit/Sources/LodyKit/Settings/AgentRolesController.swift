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
  private var observer: NSObjectProtocol?

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
    refresh()
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
        self.snapshot = next
        self.syncedAt = LodyRelativeTime.now()
      } else {
        self.failed = true
      }
      self.loading = false
      self.pulled = false
      self.render()
    }
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
    add.isEnabled = snapshot?.agents.isEmpty == false && !loading && !failed
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
    guard let snapshot, !loading, !failed else { return }
    let id = version
    let editor = AgentRoleEditorController(
      workspace: workspace, scope: scope, role: role, agents: snapshot.agents, service: service
    )
    editor.saved = { [weak self] in
      guard let self, self.version == id else { return }
      self.refresh()
    }
    LodyShell.shared.presentNative(editor, title: AgentRoleSections.text("edit"))
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
