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
  private var version = 0
  private var observer: NSObjectProtocol?

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
    }
    sync(force: true)
  }

  private func sync(force: Bool = false) {
    let next = fixed ?? .current
    let scopeChanged = next.key != workspace.key
    workspace = next
    guard force || scopeChanged else { return render() }
    snapshot = nil
    failed = false
    unconfirmed = false
    pulled = false
    loadedAt = nil
    read()
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
      let next = try? await service(.list(workspace.workspaceId))
      guard let self, self.version == id else { return }
      if let next {
        self.snapshot = next
        self.unconfirmed = false
        self.loadedAt = LodyRelativeTime.now()
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
      let next = try? await service(.set(workspace.workspaceId, row: row, shared: shared))
      guard let self else { return }
      self.mutating = false
      guard self.version == id else { return }
      if let next {
        self.snapshot = next
        self.failed = false
        self.changed()
      } else {
        self.unconfirmed = true
      }
      self.busy = false
      self.render()
    }
  }

  private func render() {
    let catalog = workspace.catalog
    let hasData = snapshot?.rows.isEmpty == false || !catalog.projects.isEmpty
    let state = LodyListState.make(
      title: String(localized: "settings.unavailable.projects", bundle: .lody), hasData: snapshot != nil, loading: busy, failed: failed,
      offline: !workspace.connected, unconfirmed: unconfirmed, syncedAt: loadedAt
    )
    list.setRefreshing(pulled && busy)
    list.setLoading(state.loading)
    list.setNotice(state.notice)
    list.setUnavailable(state.unavailable)
    list.setPlaceholder(snapshot != nil && !busy && !hasData ? ProjectVisibilitySections.text("empty") : "")
    guard let snapshot, hasData else { return list.setSections([]) }
    let rows = ProjectVisibilitySections.make(
      snapshot, catalog: catalog, enabled: !busy && !failed && !unconfirmed,
      presence: workspace.connected ? workspace.presence : .unknown
    )
    list.setSections(
      [SettingsText.footer("scope", ProjectVisibilitySections.text("hintShort"))] + rows
        + [SettingsText.footer("footer", ProjectVisibilitySections.text("footer"))]
    )
  }

  private func event(_ name: String, _ body: [String: Any]) {
    switch name {
    case "refresh":
      pulled = true
      read()
    case "noticeAction", "unavailableAction":
      read()
    case "rowAction":
      guard let id = body["id"] as? String, let action = body["actionId"] as? String,
            ["shared", "private"].contains(action), !busy, !failed, !unconfirmed, !mutating,
            let row = snapshot?.rows.first(where: { $0.id == id }), row.ownerUserId == snapshot?.userId,
            row.sharedWithTeam != (action == "shared") else { return }
      write(row, shared: action == "shared")
    default:
      break
    }
  }

  static func cloud(_ request: VisibilityRequest) async throws -> VisibilitySnapshot {
    let payload = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
    let snapshot = try JSONDecoder().decode(
      VisibilitySnapshot.self, from: Data(try await WorkspaceSettingsCloud.run(payload).utf8)
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
