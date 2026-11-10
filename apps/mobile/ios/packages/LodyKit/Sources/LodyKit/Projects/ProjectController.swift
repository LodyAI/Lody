import UIKit

@MainActor
class ProjectController: UIViewController {
  let list = SessionListView()
  let source: SessionSource
  let projectId: String
  private let connected: @MainActor () -> Bool
  private lazy var actions = SessionActions(source: source)
  private var views: [String: Double] = [:]
  private var viewsKey = ""
  private var viewsLoad = 0
  private var observers: [NSObjectProtocol] = []
  private lazy var newSessionItem = LodyFormController.barButton(
    symbol: "plus", label: String(localized: "project.newSession.accessibility", bundle: .lody)
  ) { [weak self] in self?.newSession() }

  init(
    projectId: String, source: SessionSource = .live,
    connected: @escaping @MainActor () -> Bool = { SessionCatalogPreview.state != nil || SettingsWorkspace.current.connected }
  ) {
    self.projectId = projectId
    self.source = source
    self.connected = connected
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "project.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.accessibilityIdentifier = "ipad-project-list"
    list.setContentStyle(true)
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    view.addSubview(list)
    observers = (source.changes + [UIApplication.didBecomeActiveNotification]).map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      }
    }
    render()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    render()
  }

  func render() {
    let state = source.state
    loadViews(state)
    let catalog = state.catalog.viewed(views)
    let project = catalog.projects.first { $0.id == projectId }
    let page = parent ?? self
    page.title = project?.name ?? String(localized: "project.title", bundle: .lody)
    page.navigationItem.title = page.title
    let items = project.map { SessionRows.isChat($0.id) } == false ? [newSessionItem] : []
    if (page.navigationItem.rightBarButtonItems ?? []) != items { page.navigationItem.rightBarButtonItems = items }
    let now = LodyRelativeTime.now()
    let sessions = catalog.sessions.filter { $0.projectId == projectId }.sorted(by: SessionRows.byActivity)
    var scoped = catalog
    scoped.sessions = sessions
    var sections = InboxSections.home(scoped, grouping: .time, now: now)
    let archivedRows = SessionRows.treeRows(sessions.filter(\.archived), all: catalog.sessions) {
      SessionRows.row($0, now: now)
    }
    if !archivedRows.isEmpty {
      sections.append(LodyListSection(id: "archived", header: String(localized: "session.state.archived", bundle: .lody), rows: archivedRows))
    }
    var placeholder = "project.empty"
    if state.loading {
      placeholder = "common.loading"
    } else if !connected() {
      placeholder = "project.offline"
    }
    list.setPreviewUserId(state.userId)
    list.setPreviewWorkspaceId(state.workspaceId)
    list.setPlaceholder(String(localized: String.LocalizationValue(placeholder), bundle: .lody))
    list.setSections(sections)
  }

  private func newSession() {
    let workspace = source.state.workspaceId
    guard !workspace.isEmpty else { return }
    SessionActions.create([
      "workspaceId": workspace, "projectId": projectId,
      "zoomSourceLabel": String(localized: "project.newSession.accessibility", bundle: .lody),
    ])
  }

  private func loadViews(_ state: SessionListState) {
    if state.key != viewsKey {
      viewsKey = state.key
      views = [:]
    }
    viewsLoad += 1
    let load = viewsLoad
    Task { [weak self] in
      let next = await SessionSource.views(userId: state.userId, workspaceId: state.workspaceId)
      guard let self, self.viewsLoad == load, next != self.views else { return }
      self.views = next
      self.render()
    }
  }

  private func event(_ name: String, _ body: [String: Any]) {
    guard let id = body["id"] as? String else { return }
    switch name {
    case "rowPress" where body["expanded"] == nil:
      actions.open(id, from: self)
    case "rowAction":
      guard let action = body["actionId"] as? String else { return }
      actions.perform(action, row: id, from: self)
    default:
      break
    }
  }
}
