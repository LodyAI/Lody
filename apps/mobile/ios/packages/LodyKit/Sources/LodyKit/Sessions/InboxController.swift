import UIKit

@MainActor
final class InboxController: UIViewController {
  let list = SessionListView()
  let source: SessionSource
  private let chrome = InboxChrome()
  private lazy var actions = SessionActions(source: source)
  private var mode = InboxController.storedIndex("inboxView")
  private var sort = InboxSort.allCases[InboxController.storedIndex("inboxProjectSort")]
  private var expanded = UserDefaults.standard.dictionary(forKey: "inboxExpansion") as? [String: Bool] ?? [:]
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
    loadPreferences()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.accessibilityIdentifier = "ipad-inbox-list"
    list.setContentStyle(true)
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    view.addSubview(list)
    wireChrome()
    observers = (source.changes + [UIApplication.didBecomeActiveNotification, .lodyHomeGroupingChanged]).map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      }
    }
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitHorizontalSizeClass.self]) { (self: Self, _: UITraitCollection) in self.render() }
    // UI Verify can reset the prefs after this controller has already read them.
    observers.append(NotificationCenter.default.addObserver(forName: .lodyInboxPreferencesReset, object: nil, queue: .main) {
      [weak self] _ in MainActor.assumeIsolated { self?.reloadPreferences() }
    })
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    LodyScrollEdges.bind(list.scrollView, to: self)
    chrome.layout()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    if let parent {
      chrome.attach(to: parent, content: self, scrollView: list.sidebarScrollView)
      render()
    } else {
      chrome.detach()
    }
  }

  func render() {
    guard isViewLoaded else { return }
    let state = source.state
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
    list.setProjectIndexEnabled(!state.userId.isEmpty && query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && traitCollection.horizontalSizeClass != .regular && HomeGrouping.stored == .project)
    guard !state.userId.isEmpty else {
      chrome.update(nil)
      list.setPlaceholder("")
      list.setSections([])
      return
    }
    let catalog = state.catalog.viewed(views)
    chrome.update(InboxChrome.Model(
      accountEmail: state.accountEmail,
      workspaces: state.workspaces, selected: state.workspace,
      devices: InboxDevices(catalog: state.catalog, presence: state.presence),
      running: state.catalog.sessions.filter { !$0.archived && SessionState($0) == .live }.count,
      mode: mode, sort: sort, connection: syncState(state)
    ))
    list.setPreviewUserId(state.userId)
    list.setPreviewWorkspaceId(state.workspaceId)
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    list.setPinsGroupLabels(term.isEmpty)
    guard term.isEmpty else {
      renderSearch(term, state: state, catalog: catalog)
      return
    }
    list.setPlaceholder(listPlaceholder(state))
    // iPhone Home groups by the view menu's choice (time / project / status).
    if traitCollection.horizontalSizeClass != .regular {
      let owner = HomeScope.stored == .mine ? state.userId : nil
      list.setSections(InboxSections.home(catalog, grouping: HomeGrouping.stored, owner: owner, idleExpanded: idleExpanded))
      return
    }
    let pinOrder = pinOrder(state, catalog: catalog)
    if mode == 0 {
      list.setSections(InboxSections.projects(catalog, expanded: expanded, sort: sort, pinOrder: pinOrder))
    } else {
      list.setSections(InboxSections.inbox(catalog, chatOnly: mode == 2, pinOrder: pinOrder))
    }
  }

  private func wireChrome() {
    chrome.selectWorkspace = { [weak self] id in self?.selectWorkspace(id) }
    chrome.setView = { [weak self] mode in self?.setView(mode) }
    chrome.setSort = { [weak self] sort in
      guard let self else { return }
      self.sort = sort
      UserDefaults.standard.set(InboxSort.allCases.firstIndex(of: sort) ?? 0, forKey: "inboxProjectSort")
      self.render()
    }
    // The application shell owns these presentations so external links can dismiss them.
    // iPhone pushes Settings over Chats (it opens from the header, not a tab); iPad keeps the sheet.
    chrome.openSettings = { [weak self] in
      let regular = self?.traitCollection.horizontalSizeClass == .regular
      LodyShell.shared.openPage("settings", options: regular ? ["present": true] : [:], from: self?.parent)
    }
    chrome.openDebug = { [weak self] in LodyShell.shared.openPage("debug", from: self?.parent) }
    chrome.newSession = { [weak self] in self?.newSession() }
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
    if !state.connected { return .offline }
    return state.loading ? .syncing : .live
  }

  private func listPlaceholder(_ state: SessionListState) -> String {
    if state.loading { return String(localized: "sessions.placeholder.loading", bundle: .lody) }
    if !state.connected { return String(localized: "sessions.placeholder.offline", bundle: .lody) }
    return String(localized: "sessions.placeholder.empty", bundle: .lody)
  }

  private func pinOrder(_ state: SessionListState, catalog: SessionCatalog) -> [String] {
    let key = "inboxPinOrder.\(state.userId).\(state.workspaceId)"
    let stored = state.workspaceId.isEmpty ? [] : UserDefaults.standard.stringArray(forKey: key) ?? []
    let activity = Dictionary(catalog.sessions.map { ($0.id, $0.activityAt) }, uniquingKeysWith: { first, _ in first })
    let order = InboxSections.reconcilePinOrder(
      stored, pinned: catalog.sessions.filter(\.pinned).map(\.id), activity: { activity[$0] ?? 0 }
    )
    if !state.workspaceId.isEmpty, order != stored { UserDefaults.standard.set(order, forKey: key) }
    return order
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
      if consume(id, expanded: body["expanded"] as? Bool ?? true) { return }
      let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
      actions.open(id, findQuery: term.isEmpty ? nil : term, from: self)
    case "rowAction":
      guard let action = body["actionId"] as? String else { return }
      actions.perform(action, row: id, from: self)
    default:
      break
    }
  }

  private func consume(_ id: String, expanded open: Bool) -> Bool {
    if id == InboxSections.idleMoreId {
      idleExpanded.toggle()
      render()
      return true
    }
    if id == "view:\(InboxSections.chatId)" {
      setView(2)
      return true
    }
    if id.hasPrefix("toggle:") {
      let project = String(id.dropFirst(7))
      expanded[project] = open
      var stored = UserDefaults.standard.dictionary(forKey: "inboxExpansion") as? [String: Bool] ?? [:]
      stored[project] = open
      UserDefaults.standard.set(stored, forKey: "inboxExpansion")
      render()
      return true
    }
    return InboxSections.isChatRow(id)
  }

  private func setView(_ next: Int) {
    mode = next
    UserDefaults.standard.set(next, forKey: "inboxView")
    render()
  }

  private func selectWorkspace(_ id: String) {
    guard NativeHomeFixture.active else {
      CatalogSession.shared.selectWorkspace(id)
      return
    }
    Task { try? await NativeHomeFixture.request("selectWorkspace", ["workspaceId": id]) }
  }

  func newSession() {
    let state = source.state
    guard state.workspace != nil else {
      LodyToastOverlay.shared.show(message: String(localized: "tabs.toast.signInFirst", bundle: .lody), kind: .neutral)
      return
    }
    SessionActions.create(["workspaceId": state.workspaceId, "zoomSourceLabel": String(localized: "tabs.newSession", bundle: .lody)])
  }

  private func loadPreferences() {
    mode = Self.storedIndex("inboxView")
    sort = InboxSort.allCases[Self.storedIndex("inboxProjectSort")]
    expanded = UserDefaults.standard.dictionary(forKey: "inboxExpansion") as? [String: Bool] ?? [:]
  }

  private func reloadPreferences() {
    loadPreferences()
    render()
  }

  private static func storedIndex(_ key: String) -> Int {
    let value = UserDefaults.standard.integer(forKey: key)
    return (0...2).contains(value) ? value : 0
  }
}

extension Notification.Name {
  static let lodyInboxPreferencesReset = Notification.Name("LodyInboxPreferencesReset")
}
