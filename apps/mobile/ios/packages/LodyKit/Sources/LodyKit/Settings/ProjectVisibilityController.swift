import LodyCore
import UIKit

@MainActor
class ProjectVisibilityController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  private let service: VisibilityService
  private let fixed: SettingsWorkspace?
  private let changed: @MainActor () -> Void
  private var workspace = SettingsWorkspace()
  private var snapshot: VisibilitySnapshot?
  private var busy = true
  private var failed = false
  private var unconfirmed = false
  private var pulled = false
  private var mutating = false
  private var loadedAt: Double?
  /// Whether `snapshot` came from a live read; a cached snapshot only displays, never authorizes writes.
  private var live = false
  private var version = 0
  private var observer: NSObjectProtocol?
  private var groupObserver: NSObjectProtocol?
  /// The workspace's Project groups; previews with a fixed workspace list none.
  private var groups: [RuntimeContract.ProjectGroupItem] {
    let store = ProjectGroupStore.shared
    guard fixed == nil, store.scope == workspace.key else { return [] }
    return store.groups
  }
  /// The account/workspace-scoped last accepted registrations; previews with a fixed workspace keep none.
  private var store: SettingsSnapshotStore<VisibilitySnapshot>? {
    guard fixed == nil else { return nil }
    return SettingsSnapshotStore(kind: "project-visibility", userId: workspace.userId, workspaceId: workspace.workspaceId)
  }

  init(
    workspace: SettingsWorkspace? = nil,
    service: @escaping VisibilityService = ProjectVisibilityController.cloud,
    changed: @escaping @MainActor () -> Void = { CatalogSession.shared.refresh() }
  ) {
    fixed = workspace
    self.service = service
    self.changed = changed
    super.init(nibName: nil, bundle: nil)
    title = ProjectVisibilitySections.text("title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    if let groupObserver { NotificationCenter.default.removeObserver(groupObserver) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    view.addSubview(list)
    if fixed == nil {
      observer = NotificationCenter.default.addObserver(forName: .lodyCatalogDidChange, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.sync() }
      }
      groupObserver = NotificationCenter.default.addObserver(forName: .lodyProjectGroupsDidChange, object: nil, queue: .main) {
        [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      }
    }
    sync(force: true)
  }

  private func sync(force: Bool = false) {
    let next = fixed ?? .current
    let scopeChanged = next.key != workspace.key
    // Catalog events arrive every few seconds (sessions, presence); re-rendering an unchanged
    // projection reconfigures every row and makes their values blink.
    guard force || scopeChanged || next != workspace else { return }
    workspace = next
    guard force || scopeChanged else { return render() }
    snapshot = nil
    failed = false
    unconfirmed = false
    pulled = false
    loadedAt = nil
    live = false
    version += 1
    let id = version, store = store
    if fixed == nil, !next.key.isEmpty {
      ProjectGroupStore.shared.refresh(userId: next.userId, workspaceId: next.workspaceId)
    }
    render()
    Task { [weak self] in
      // The last accepted registrations show at once; the live read replaces them.
      let cached = await store?.read()
      guard let self, self.version == id else { return }
      if let cached, cached.userId == self.workspace.userId, self.snapshot == nil { self.snapshot = cached }
      self.read()
    }
  }

  private func read() {
    guard !mutating else { return }
    version += 1
    guard !workspace.key.isEmpty else {
      busy = false
      pulled = false
      return render()
    }
    let id = version
    busy = true
    failed = false
    render()
    Task { [weak self, service, workspace] in
      let next = try? await service(.list(workspace.workspaceId), workspace.userId)
      guard let self, self.version == id else { return }
      if let next {
        self.accept(next)
        self.unconfirmed = false
      } else {
        self.failed = true
      }
      self.busy = false
      self.pulled = false
      self.render()
    }
  }

  private func write(_ row: VisibilityRow, shared: Bool) {
    mutating = true
    busy = true
    version += 1
    let id = version
    render()
    Task { [weak self, service, workspace] in
      let next = try? await service(.set(workspace.workspaceId, row: row, shared: shared), workspace.userId)
      guard let self else { return }
      self.mutating = false
      guard self.version == id else { return }
      if let next {
        self.accept(next)
        self.failed = false
        self.changed()
      } else {
        self.unconfirmed = true
      }
      self.busy = false
      self.render()
    }
  }

  private func accept(_ next: VisibilitySnapshot) {
    snapshot = next
    live = true
    loadedAt = LodyRelativeTime.now()
    store?.write(next)
  }

  // The local project catalog is shown at once; registrations (cached, then live) only add
  // each project's sharing state, so a slow, failed or empty registration read never blanks the page.
  private func render() {
    let catalog = workspace.catalog
    let groupSection = ProjectGroupSections.section(groups, machineNames: catalog.machineNames)
    let hasData = snapshot?.rows.isEmpty == false || !catalog.projects.isEmpty || groupSection != nil
    let state = LodyListState.make(
      title: String(localized: "settings.unavailable.projects", bundle: .lody), hasData: hasData, loading: busy, failed: failed,
      offline: !workspace.connected, unconfirmed: unconfirmed, syncedAt: loadedAt
    )
    list.setRefreshing(pulled && busy)
    list.setLoading(state.loading)
    list.setNotice(state.notice)
    list.setUnavailable(state.unavailable)
    list.setPlaceholder(snapshot != nil && !busy && !hasData ? ProjectVisibilitySections.text("empty") : "")
    guard hasData else { return list.setSections([]) }
    let rows = ProjectVisibilitySections.make(
      snapshot, catalog: catalog, enabled: live && !busy && !failed && !unconfirmed,
      presence: workspace.connected ? workspace.presence : .unknown
    )
    // Project groups follow the folders they hold; visibility sharing applies to folders only.
    list.setSections(
      [SettingsText.footer("scope", ProjectVisibilitySections.text("hintShort"))] + rows
        + [SettingsText.footer("footer", ProjectVisibilitySections.text("footer"))]
        + (groupSection.map { [$0] } ?? [])
    )
  }

  private func event(_ name: String, _ body: [String: Any]) {
    switch name {
    case "refresh":
      pulled = true
      if fixed == nil, !workspace.key.isEmpty {
        ProjectGroupStore.shared.refresh(userId: workspace.userId, workspaceId: workspace.workspaceId)
      }
      read()
    case "rowPress":
      guard let id = body["id"] as? String, id.hasPrefix(ProjectGroupSections.rowPrefix),
            let group = groups.first(where: { ProjectGroupSections.rowPrefix + $0.id == id }) else { return }
      LodyShell.shared.pushNative(ProjectGroupController(group: group, scope: workspace.key), title: group.name, from: self)
    case "noticeAction", "unavailableAction":
      read()
    case "rowAction":
      guard let id = body["id"] as? String, let action = body["actionId"] as? String,
            ["shared", "private"].contains(action), live, !busy, !failed, !unconfirmed, !mutating,
            let row = snapshot?.effectiveRows(catalog: workspace.catalog).first(where: { $0.id == id }), row.ownerUserId == snapshot?.userId,
            row.sharedWithTeam != (action == "shared") else { return }
      write(row, shared: action == "shared")
    default:
      break
    }
  }

  static func cloud(_ request: VisibilityRequest, userId: String) async throws -> VisibilitySnapshot {
    let payload = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
    let snapshot = try JSONDecoder().decode(
      VisibilitySnapshot.self, from: Data(try await WorkspaceSettingsCloud.run(payload, userId: userId).utf8)
    )
    guard snapshot.valid else { throw CocoaError(.coderInvalidValue) }
    return snapshot
  }
}

extension SettingsWorkspace {
  @MainActor static var current: SettingsWorkspace {
    decode(state: CatalogSession.published.json, raw: CatalogSession.published.raw)
  }
}
