import UIKit

@MainActor
class ActivityController: UIViewController {
  static let activeStatuses: Set = ["running", "initializing", "processing", "in_progress", "queued", "waiting", "requestPermission"]

  let list = LodyGroupedList(frame: .zero)
  let source: SessionSource
  private let workspaceId: String
  private let userId: String
  private let localReady: @MainActor () -> Bool
  private let select: @MainActor (String) -> Void
  private lazy var actions = SessionActions(source: source)
  private var requested = ""
  private var views: [String: Double] = [:]
  private var viewsKey = ""
  private var viewsLoad = 0
  private var observers: [NSObjectProtocol] = []

  init(
    workspaceId: String, userId: String, source: SessionSource = .live,
    localReady: @escaping @MainActor () -> Bool = { AuthSession.shared.catalogScope.localReady },
    select: @escaping @MainActor (String) -> Void = { CatalogSession.shared.selectWorkspace($0) }
  ) {
    self.workspaceId = workspaceId
    self.userId = userId
    self.source = source
    self.localReady = localReady
    self.select = select
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "inbox.settings.view.activity", bundle: .lody)
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
    observers = (source.changes + [.lodyAuthDidChange, UIApplication.didBecomeActiveNotification]).map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      }
    }
    render()
  }

  static func isActive(_ session: SessionItem) -> Bool {
    guard !session.archived, !["completed", "error"].contains(session.status) else { return false }
    return session.awaitingUserSince != nil || activeStatuses.contains(session.status)
  }

  func render() {
    let state = source.state
    let allowed = state.userId == userId && state.workspaces.contains { $0.id == workspaceId }
    if allowed, state.workspaceId != workspaceId, requested != workspaceId {
      requested = workspaceId
      select(workspaceId)
    }
    let ready = allowed && state.workspaceId == workspaceId
    loadViews(state)
    var catalog = state.catalog.viewed(views)
    catalog.sessions = ready ? catalog.sessions.filter(Self.isActive) : []
    var placeholder = "activity.empty"
    if !localReady() || (allowed && (!ready || state.loading)) {
      placeholder = "common.loading"
    } else if !allowed {
      placeholder = "notifications.route.wrongAccount"
    } else if !state.connected {
      placeholder = "project.offline"
    }
    list.setPreviewUserId(state.userId)
    list.setPreviewWorkspaceId(state.workspaceId)
    list.setPlaceholder(String(localized: String.LocalizationValue(placeholder), bundle: .lody))
    list.setSections(InboxSections.inbox(catalog))
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
