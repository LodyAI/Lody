import UIKit

@MainActor
final class InboxController: UIViewController {
  let list = SessionListView()
  let source: SessionSource
  private let chrome = InboxChrome()
  private lazy var actions = SessionActions(source: source)
  private var query = ""
  /// The status view's quiet group shows everything; not persisted, so it opens folded.
  private var idleExpanded = false
  private var search: (key: String, catalog: SessionCatalog, hits: InboxSearchHits)?
  private var requested: (key: String, catalog: SessionCatalog)?
  private var searchTask: Task<Void, Never>?
  private var views: [String: Double] = [:]
  private var viewsKey = ""
  private var viewsLoad = 0
  private var members: [String: WorkspaceMember] = [:]
  private var memberScope = ""
  private var memberTask: Task<Void, Never>?
  private var observers: [NSObjectProtocol] = []
  private var renderedInput: (userId: String, workspaceId: String, catalog: SessionCatalog)?

  init(source: SessionSource = .live) {
    self.source = source
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    searchTask?.cancel()
    memberTask?.cancel()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.accessibilityIdentifier = "ipad-inbox-list"
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    view.addSubview(list)
    wireChrome()
    observers = (source.changes + [UIApplication.didBecomeActiveNotification, .lodyHomeGroupingChanged, .lodyProjectGroupsDidChange]).map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated {
          self?.render(onlyIfContentChanged: name == .lodyCatalogDidChange || name == .lodySessionCatalogPreviewDidChange)
          if name == UIApplication.didBecomeActiveNotification, self?.source === SessionSource.live,
             self?.source.state.workspace?.resolvedMode == .unknown {
            Task { await AuthSession.shared.refreshWorkspaceModes() }
          }
        }
      }
    }
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitHorizontalSizeClass.self]) { (self: Self, _: UITraitCollection) in self.render() }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    LodyScrollEdges.bind(list.scrollView, to: self)
    chrome.layout()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    if let parent {
      chrome.attach(to: parent, content: self, scrollView: list.scrollView)
      render()
    } else {
      chrome.detach()
    }
  }

  func render(onlyIfContentChanged: Bool = false) {
    guard isViewLoaded else { return }
    let state = source.state
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if source === SessionSource.live {
      ProjectGroupStore.shared.ensure(userId: state.userId, workspaceId: state.workspaceId, catalog: state.catalog)
    }
    if state.userId.isEmpty {
      chrome.update(nil)
      list.setPlaceholder("")
      list.setRetry(nil)
    } else {
      chrome.update(InboxChrome.Model(
        accountEmail: state.accountEmail,
        workspaces: state.workspaces, selected: state.workspace,
        devices: InboxDevices(catalog: state.catalog, presence: state.presence),
        connection: syncState(state)
      ))
      if term.isEmpty { list.setPlaceholder(listPlaceholder(state)) }
      let unknown = source === SessionSource.live && state.workspace?.resolvedMode == .unknown
      list.setRetry(unknown && term.isEmpty ? { Task { await AuthSession.shared.refreshWorkspaceModes() } } : nil)
    }
    // Presence and connection updates still refresh chrome, but cannot change rows.
    // Explicit renders bypass this guard for search results, identities and watermarks.
    if onlyIfContentChanged, let renderedInput,
      renderedInput.userId == state.userId, renderedInput.workspaceId == state.workspaceId,
      renderedInput.catalog == state.catalog { return }
    renderedInput = (state.userId, state.workspaceId, state.catalog)
    if memberScope != state.key {
      memberTask?.cancel()
      memberScope = state.key
      members = [:]
      if source === SessionSource.live, !LodyUIVerify.enabled, !state.key.isEmpty {
        memberTask = Task { [weak self] in
          await WorkspaceMembers.load(userId: state.userId, workspaceId: state.workspaceId) { [weak self] members in
            guard let self, self.source.state.key == state.key else { return }
            self.members = members
            self.render()
          }
        }
      }
    }
    var identities = members
    if let me = AuthSession.shared.snapshot.account?.user, me.id == state.userId {
      identities[me.id] = identities[me.id] ?? WorkspaceMember(id: me.id, name: me.name, image: me.image)
    }
    let owners: [String: WorkspaceMember] = HomeScope.stored == .team ? Dictionary(state.catalog.sessions.map { session in
      (session.id, identities[session.userId ?? ""] ?? WorkspaceMember(id: session.userId ?? "", name: "", image: nil))
    }, uniquingKeysWith: { _, new in new }) : [:]
    list.setOwners(owners)
    loadViews(state)
    list.setProjectIndexEnabled(!state.userId.isEmpty && !HomeArchive.shown && term.isEmpty && HomeGrouping.stored == .project)
    guard !state.userId.isEmpty else {
      list.setSections([])
      return
    }
    let archived = HomeArchive.shown
    list.setArchivedStyle(archived)
    var catalog = state.catalog.viewed(views)
    // The Archived switch narrows every view, search included, to archived chats.
    if archived { catalog.sessions = catalog.sessions.filter(\.archived) }
    list.setPinsGroupLabels(term.isEmpty)
    guard term.isEmpty else {
      renderSearch(term, state: state, catalog: catalog)
      return
    }
    if archived {
      list.setSections(InboxSections.archived(catalog, owner: HomeScope.stored == .mine ? state.userId : nil))
      return
    }
    // Every size class groups by the view menu's choice (time / project / status).
    let owner = HomeScope.stored == .mine ? state.userId : nil
    list.setSections(InboxSections.home(catalog, grouping: HomeGrouping.stored, owner: owner, idleExpanded: idleExpanded))
  }

  private func wireChrome() {
    chrome.selectWorkspace = { [weak self] id in self?.selectWorkspace(id) }
    // The application shell owns these presentations so external links can dismiss them.
    chrome.openSettings = { [weak self] in
      LodyShell.shared.openPage("settings", options: ["present": true], from: self?.parent)
    }
    chrome.openDebug = { [weak self] in LodyShell.shared.openPage("debug", from: self?.parent) }
    // While Schedules fills the regular-width detail column, the list's create action adds a schedule.
    chrome.newSession = { [weak self] in
      guard let self else { return }
      if self.chrome.destination == .schedules { HomeController.current?.newSchedule() } else { self.newSession() }
    }
    chrome.selectDestination = { HomeController.current?.selectTab($0) }
    chrome.searchChanged = { [weak self] text in
      guard let self, text != self.query else { return }
      self.query = text
      self.render()
    }
  }

  private func renderSearch(_ term: String, state: SessionListState, catalog: SessionCatalog) {
    let key = [state.userId, state.workspaceId, term].joined(separator: "\0")
    if requested?.key != key || requested?.catalog != catalog { requestSearch(term, key: key, state: state, catalog: catalog) }
    let current = search.flatMap { $0.key == key && $0.catalog == catalog ? $0 : nil }
    list.setPlaceholder(String(localized: String.LocalizationValue(current == nil ? "search.placeholder.loading" : "search.placeholder.noMatch"), bundle: .lody))
    list.setSections(InboxSections.search(catalog, hits: current?.hits ?? InboxSearchHits(), query: term))
  }

  private func requestSearch(_ term: String, key: String, state: SessionListState, catalog: SessionCatalog) {
    requested = (key, catalog)
    searchTask?.cancel()
    guard !state.workspaceId.isEmpty else { return }
    let (user, workspace) = (state.userId, state.workspaceId)
    searchTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(120))
      guard !Task.isCancelled else { return }
      let result: Result<InboxSearchHits, Error> = await withCheckedContinuation { done in
        LocalStore.queue.async {
          done.resume(returning: Result {
            Self.hits(try LocalStore.shared.searchInbox(userID: user, workspaceID: workspace, query: term))
          })
        }
      }
      guard let self, !Task.isCancelled, self.requested?.key == key else { return }
      switch result {
      case .success(let hits):
        self.search = (key, catalog, hits)
      case .failure:
        LodyToastOverlay.shared.show(message: String(localized: "search.toast.failed", bundle: .lody), kind: .error)
        self.search = (key, catalog, InboxSections.match(catalog, keyword: term))
      }
      self.render()
    }
  }

  private nonisolated static func hits(_ raw: [String: Any]) -> InboxSearchHits {
    let sessions = (raw["sessions"] as? [[String: Any]] ?? []).compactMap { item -> (id: String, snippet: String?)? in
      guard let id = item["id"] as? String else { return nil }
      return (id, item["snippet"] as? String)
    }
    return InboxSearchHits(projectIds: raw["projectIds"] as? [String] ?? [], sessions: sessions)
  }

  private func syncState(_ state: SessionListState) -> HomeSyncState {
    if !state.connected { return .connecting }
    return state.loading ? .syncing : .live
  }

  private func listPlaceholder(_ state: SessionListState) -> String {
    if source === SessionSource.live, let workspace = AuthSession.shared.snapshot.account?.workspaces.first(where: { $0.id == state.workspaceId }) {
      switch workspace.resolvedMode {
      case .e2ee: return String(localized: "workspace.e2ee.unsupported", bundle: .lody)
      case .unknown: return String(localized: "workspace.mode.unknown", bundle: .lody)
      case .plaintext: break
      }
    }
    if state.loading { return String(localized: "sessions.placeholder.loading", bundle: .lody) }
    if !state.connected { return String(localized: "sessions.placeholder.offline", bundle: .lody) }
    let empty = HomeArchive.shown ? "home.archived.empty" : "sessions.placeholder.empty"
    return String(localized: String.LocalizationValue(empty), bundle: .lody)
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
    case "rowPress":
      if consume(id) { return }
      let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
      actions.open(id, findQuery: term.isEmpty ? nil : term, from: self)
    case "rowAction":
      guard let action = body["actionId"] as? String else { return }
      actions.perform(action, row: id, from: self)
    default:
      break
    }
  }

  private func consume(_ id: String) -> Bool {
    // The Chats pseudo-project has no page of its own.
    guard id == InboxSections.idleMoreId else { return InboxSections.isChatRow(id) }
    idleExpanded.toggle()
    render()
    return true
  }

  private func selectWorkspace(_ id: String) {
    guard NativeHomeFixture.active else {
      CatalogSession.shared.selectWorkspace(id)
      return
    }
    Task { try? await NativeHomeFixture.request("selectWorkspace", ["workspaceId": id]) }
  }

  /// Regular width: which Home destination the detail column shows (the bottom bar's selection).
  func setDestination(_ tab: HomeTab) { chrome.destination = tab }

  func newSession() {
    let state = source.state
    guard state.workspace?.resolvedMode == .plaintext else {
      LodyToastOverlay.shared.show(message: String(localized: "tabs.toast.signInFirst", bundle: .lody), kind: .neutral)
      return
    }
    SessionActions.create(["workspaceId": state.workspaceId, "zoomSourceLabel": String(localized: "tabs.newSession", bundle: .lody)])
  }
}
