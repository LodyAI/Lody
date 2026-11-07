import UIKit

@MainActor
class ArchivedSessionsController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  let source: SessionSource
  private lazy var actions = SessionActions(source: source)
  private var views: [String: Double] = [:]
  private var viewsKey = ""
  private var viewsLoad = 0
  private var observers: [NSObjectProtocol] = []

  init(source: SessionSource = .live) {
    self.source = source
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "settings.archived.title", bundle: .lody)
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

  func render() {
    let state = source.state
    loadViews(state)
    let catalog = state.catalog.viewed(views)
    let names = Dictionary(catalog.projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    let now = LodyRelativeTime.now()
    let archived = catalog.sessions.filter(\.archived).sorted(by: SessionRows.byActivity)
    let rows = SessionRows.treeRows(archived, all: catalog.sessions) { session in
      SessionRows.row(session, projectName: names[session.projectId] ?? "", now: now)
    }
    var section = LodyListSection()
    section.id = "archived"
    section.rows = rows
    list.setPreviewUserId(state.userId)
    list.setPreviewWorkspaceId(state.workspaceId)
    list.setPlaceholder(String(localized: String.LocalizationValue(state.loading ? "common.loading" : "settings.archived.empty"), bundle: .lody))
    list.setSections(rows.isEmpty ? [] : [section])
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
