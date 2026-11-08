import LodyCore
import UIKit
import SwiftUI

@MainActor
class SessionController: UIViewController, LodyPageOwnedHeader {
  typealias BrowserRequest = @MainActor (SessionListState, RuntimeContract.SessionPreviewParamsAction) async throws -> RuntimeContract.SessionPreviewResult
  let chat = LodyChatView(frame: .zero)
  let source: SessionSource
  let sessionId: String
  var environment: SessionSendEnvironment
  private let feedService: SessionFeedService
  private let findQuery: String
  private lazy var actions = SessionActions(source: source)
  private(set) var feed: SessionFeed?
  lazy var composerModel = SessionComposerModel(choice: initialChoice, service: environment.composer)
  lazy var control = SessionControl(request: environment.control)
  var sender: SessionSender?
  let planDecision = SessionDecision(.plan)
  let errorRetry = SessionDecision(.retry)
  let itemDetailService: ItemDetailService
  let permissionService: PermissionService
  var permissionGate = SessionPermissionGate()
  weak var subagentPage: SubagentTaskController?
  var simulator: SessionSimulator?
  var openingSimulator = false
  var browserBusy = false
  let requestBrowserPreview: BrowserRequest
  let simulatorService: SimulatorService?
  let pullRequestPage: @MainActor (SessionPullRequest, SessionListState) -> PullRequestController
  weak var processPage: ProcessController?
  weak var tasksPage: TasksController?
  var permissionPage: PermissionController?
  var permissionScope: (userId: String, workspaceId: String)?
  var openingFiles: Set<String> = []
  var mentions: MentionCatalogStore?
  var mentionSequence = 0
  var editable = ""
  var editCheck = ""
  var quotaEntry = "pending"
  var rendered: [String: String] = [:]
  var infoBar: SessionInfoBar?
  var githubOperation: String?
  var githubScope = ""
  var githubUpdates = SessionPullRequestUpdates()
  private let initialChoice: ModelChoice?
  private var observers: [NSObjectProtocol] = []
  private var findToken = 0
  private var listed = false
  private let moreButton = UIButton(type: .system)
  private let backButton = UIButton(type: .system)
  private let sidebarButton = UIButton(type: .system)
  private var sidebarAction: UIAction?
  private let pageHeader = UIStackView()
  private lazy var tabsButton: DirectoryTabsButton = {
    let button = DirectoryTabsButton()
    button.addAction(UIAction { [weak self] _ in self?.presentTabs() }, for: .touchUpInside)
    return button
  }()
  private var tabViews: [String: Double] = [:]
  private var tabViewsKey = ""
  private var tabViewsLoad = 0
  private var browsingVisible = false
  private var renderedEntries: String?
  private var memberScope = ""
  private var memberTask: Task<Void, Never>?
  var copyService = SessionCopyService.live
  var pendingOwner: (sessionId: String, userId: String)?

  init(sessionId: String, findQuery: String = "", choice: ModelChoice? = nil, source: SessionSource = .live,
       feed: SessionFeedService = .live, environment: SessionSendEnvironment = .live, permission: PermissionService = .live,
       itemDetail: ItemDetailService? = nil, simulator: SimulatorService? = nil,
       pullRequest: @escaping @MainActor (SessionPullRequest, SessionListState) -> PullRequestController = SessionController.livePullRequest,
       browser: BrowserRequest? = nil) {
    requestBrowserPreview = browser ?? { state, action in
      guard let runtime = DataRuntime.current, runtime.workspace == state.workspaceId, runtime.userId == state.userId else { throw OutboxError.scopeExpired }
      return try await runtime.perform(RuntimeContract.Calls.SessionPreview.self, .init(sessionId: sessionId, userId: state.userId, action: action))
    }
    self.sessionId = sessionId
    self.findQuery = findQuery
    self.source = source
    self.environment = environment
    permissionService = permission
    itemDetailService = itemDetail ?? .live(sessionId: sessionId)
    simulatorService = simulator
    pullRequestPage = pullRequest
    initialChoice = choice
    feedService = feed
    super.init(nibName: nil, bundle: nil)
  }

  convenience init(params: [String: Any]) {
    let keys = ["modelId", "effort", "modeId"]
    var choice: ModelChoice?
    if keys.contains(where: { params[$0] is String }) {
      choice = ModelChoice(modelId: params["modelId"] as? String, effort: params["effort"] as? String, modeId: params["modeId"] as? String)
    }
    let sessionId: String
    if let id = params["sessionId"] as? String { sessionId = id }
    else { sessionId = (params["session"] as! [String: Any])["id"] as! String }
    self.init(sessionId: sessionId, findQuery: params["findQuery"] as? String ?? "", choice: choice)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    memberTask?.cancel()
    feed?.finish()
    simulator?.finish()
    if sender != nil { environment.foreground(sessionId, false) }
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
  }

  var queuedMessageBehavior: String { LodyPreferences.queuedMessageBehavior }
  var persistsDraft: Bool { true }
  /// Browser preview and simulator icons for the action bar; preview fixtures override them.
  var resourceItems: [[String: Any]] { [browserItem, simulatorItem].compactMap { $0 } }
  func adjustComposer(_ state: inout [String: Any]) {}

  // The chat binds its title and scroll edges to its nearest controller; the shell page shows this item.
  override var navigationItem: UINavigationItem { parent?.navigationItem ?? super.navigationItem }

  override func viewDidLoad() {
    super.viewDidLoad()
    chat.pageOwnsHeader = true
    view.backgroundColor = .lodyBackground
    view.addSubview(chat)
    installPageHeader()
    chat.imageSharingEnabled = false
    wireEvents()
    find(query: findQuery, keyboard: false)
    wireSendEvents()
    wireDecisionEvents()
    wireRouteEvents()
    chat.onPreview = { [weak self] body in
      if let action = body["action"] as? String { self?.contextAction(action) }
    }
    wireMentionEvents()
    observers = (source.changes + [UIApplication.didBecomeActiveNotification, .lodyPreferencesDidChange]).map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
        let activated = note.name == UIApplication.didBecomeActiveNotification
        let viewsChanged = note.name == .lodySessionViewsDidChange
        MainActor.assumeIsolated {
          if viewsChanged { self?.loadTabViews() }
          self?.render()
          if activated { self?.markViewed() }
        }
      }
    }
    render()
  }

  override func viewIsAppearing(_ animated: Bool) {
    super.viewIsAppearing(animated)
    updatePageBack()
    browsingVisible = true
    NotificationCenter.default.post(name: LodyScrollEdges.ownerChanged, object: self)
    let slug = source.state.workspace?.slug ?? ""
    PushNotifications.shared.visibleRoute = slug.isEmpty ? "" : "/\(slug)/sessions/\(sessionId)"
    markViewed()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    updatePageBack()
    renderPermission()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    #if DEBUG
    if LodyUIVerify.enabled, let coordinator = transitionCoordinator ?? parent?.transitionCoordinator,
       coordinator.isInteractive {
      let probe = SessionHeaderTransitionProbe(page: view, controls: [backButton, chat.titleButton, moreButton], coordinator: coordinator)
      coordinator.animate(alongsideTransition: nil) { context in probe.finish(cancelled: context.isCancelled) }
    }
    #endif
    browsingVisible = false
    PushNotifications.shared.visibleRoute = ""
    if SettingsPage.leaving(self) {
      permissionPage?.update(nil, ready: true)
      processPage?.navigationController?.presentingViewController?.dismiss(animated: false)
    }
  }

  func render() {
    guard isViewLoaded else { return }
    let state = source.state
    if state.key != memberScope {
      memberTask?.cancel()
      memberScope = state.key
      chat.members = [:]
      if source === SessionSource.live, !LodyUIVerify.enabled, !state.key.isEmpty {
        memberTask = Task { [weak self] in
          await WorkspaceMembers.load(userId: state.userId, workspaceId: state.workspaceId) { [weak self] members in
            guard let self, self.source.state.key == state.key else { return }
            self.chat.members = members
            // Change owner lists the members, so the menu follows the loaded list.
            if let session = self.source.state.catalog.session(self.sessionId) {
              self.updateMoreMenu(session)
              self.render()
            }
          }
        }
      }
    }
    guard let session = state.catalog.session(sessionId) else {
      permissionPage?.update(nil, ready: true)
      if listed, !state.loading { LodyShell.shared.close(from: self) }
      return
    }
    listed = true
    if tabViewsKey != state.key {
      tabViewsKey = state.key
      tabViews = [:]
      loadTabViews()
    }
    markViewed()
    prepareSimulator(state, session)
    startFeed(state)
    chat.setAttachmentContext(Self.json(["workspaceId": state.workspaceId, "sessionId": sessionId]))
    chat.showsThoughts = session.cliType == "builtin" && session.agentType == "deepseek"
    chat.setNavigationTitle(session.title)
    let tabs = DirectoryTabs.sessions(current: session, all: state.catalog.sessions)
    chat.setDirectoryTabs("", symbol: "")
    chat.setNavigationMachine(state.catalog.machineNames[session.machineId] ?? "")
    chat.setNavigationMachineState(state.presence.status(of: session.machineId))
    let others = tabs.filter { $0.id != sessionId }.map { session in
      var viewed = session
      if let at = tabViews[session.id] { viewed.lastViewedMessageAt = max(viewed.lastViewedMessageAt ?? -.infinity, at) }
      return viewed
    }
    tabsButton.setStatus(DirectoryTabs.symbol(others))
    tabsButton.accessibilityLabel = String(format: String(localized: "session.tabs.count", bundle: .lody), tabs.count)
    // The trailing directory button opens the panel below the header.
    directoryTabs = tabs
    closedDirectoryTabs = DirectoryTabs.closed(current: session, all: state.catalog.sessions)
    if let panel = ChatTabsOverlay.shown(in: (parent ?? self).view) {
      panel.state.tabs = tabItems(directoryTabs)
      panel.state.closed = tabItems(closedDirectoryTabs)
    }
    chat.setTitleMenu("[]")
    chat.mentionRepository = session.projectId.hasPrefix("github:") ? String(session.projectId.dropFirst(7)) : ""
    renderMentions(state, session)
    renderFeed(session)
    updateMoreMenu(session)
  }

  private func startFeed(_ state: SessionListState) {
    guard feed == nil, !state.userId.isEmpty, !state.workspaceId.isEmpty else { return }
    let feed = SessionFeed(sessionId: sessionId, userId: state.userId, workspaceId: state.workspaceId, service: feedService)
    feed.changed = { [weak self] in
      guard let self, let session = self.source.state.catalog.session(self.sessionId) else { return }
      self.renderFeed(session)
    }
    self.feed = feed
    startSender(state)
    feed.start()
  }

  private func renderFeed(_ session: SessionItem) {
    let state = feed?.state ?? SessionFeedState()
    if session.isTabClosed {
      chat.setEntries("[]")
      renderedEntries = nil
      chat.setEmptyText(String(localized: "session.tabs.allClosed", bundle: .lody))
      chat.setTabClosed(true)
      chat.scheduleUpdate()
      return
    }
    chat.setTabClosed(false)
    renderComposer(session, state)
    renderPermission()
    chat.setEmptyText(String(localized: String.LocalizationValue(state.status == "live" ? "chat.empty.prompt" : "chat.empty.loading"), bundle: .lody))
    guard state.entriesJSON != renderedEntries else { return }
    renderedEntries = state.entriesJSON
    processPage?.update(state.entriesJSON, animate: state.isLiveUpdate)
    tasksPage?.update(state.entriesJSON)
    updateDetails(state.entriesJSON)
    chat.setEntries(state.entriesJSON, animate: state.isLiveUpdate)
    chat.scheduleUpdate()
  }

  private func projectName(_ session: SessionItem, catalog: SessionCatalog) -> String {
    if SessionRows.isChat(session.projectId) { return String(localized: "inbox.section.chat", bundle: .lody) }
    return catalog.projects.first { $0.id == session.projectId }?.name ?? ""
  }

  private var creatingTab = false
  private var attemptedTab: String?
  /// The conversation's Tabs (itself first), for the directory panel.
  private var directoryTabs: [SessionItem] = []
  private var closedDirectoryTabs: [SessionItem] = []
  private var changingTab = false

  private func tabItems(_ tabs: [SessionItem]) -> [ChatTabItem] {
    tabs.map { session in
      var viewed = session
      if let at = tabViews[session.id] { viewed.lastViewedMessageAt = max(viewed.lastViewedMessageAt ?? -.infinity, at) }
      return ChatTabItem(id: session.id, title: session.title, attention: Attention(viewed), current: session.id == sessionId)
    }
  }

  private func setTabClosed(_ id: String, closed: Bool) {
    guard !changingTab else { return }
    let workspace = source.state.workspaceId
    let before = directoryTabs
    let index = before.firstIndex { $0.id == id }
    let next = index.flatMap { index in before.dropFirst(index + 1).first ?? before.prefix(index).last }
    let overlay = ChatTabsOverlay.shown(in: (parent ?? self).view)
    changingTab = true
    overlay?.state.busy = id
    Task { [weak self] in
      guard let self else { return }
      defer { self.changingTab = false; overlay?.state.busy = nil }
      do {
        try await self.source.write(workspace, id, .tabClosed(closed))
        guard self.source.state.workspaceId == workspace, self.view.window != nil, overlay?.window != nil else { return }
        self.render()
        if !closed {
          overlay?.close {
            if id == self.sessionId { self.render() }
            else { self.titleMenuSelected("tab:" + id) }
          }
        } else if id == self.sessionId, let next {
          overlay?.close { self.titleMenuSelected("tab:" + next.id) }
        }
      } catch {
        LodyToastOverlay.shared.show(message: String(localized: "session.tabs.changeFailed", bundle: .lody), kind: "error")
      }
    }
  }

  /// The directory panel grows from its toolbar button; selection, creation and history stay together.
  private func presentTabs(showClosed: Bool = false) {
    let host: UIViewController = parent ?? self
    if let shown = ChatTabsOverlay.shown(in: host.view) { return shown.close() }
    guard host.presentedViewController == nil else { return }
    let items = tabItems(directoryTabs)
    let state = ChatTabsState(tabs: items, closed: tabItems(closedDirectoryTabs))
    state.showingClosed = showClosed
    weak var overlay: ChatTabsOverlay?
    let panel = ChatTabsPanel(
      state: state,
      onSelect: { [weak self] id in
        overlay?.close { self?.titleMenuSelected("tab:" + id) }
      },
      onClose: { [weak self] in self?.setTabClosed($0, closed: true) },
      onRestore: { [weak self] in self?.setTabClosed($0, closed: false) }
    )
    overlay = ChatTabsOverlay.present(panel, tabs: items.count, in: host, source: directoryTabs.count > 1 ? tabsButton : chat.tabsAnchorView)
  }

  private func createTab() {
    guard !creatingTab, let runtime = DataRuntime.current else { return }
    if let attemptedTab {
      LodyShell.shared.openSessionFromExternal(attemptedTab)
      return
    }
    let target = UUID().uuidString.lowercased()
    attemptedTab = target
    creatingTab = true
    render()
    Task { [weak self] in
      guard let self else { return }
      defer { self.creatingTab = false; self.render() }
      do {
        let result = try await runtime.workspaceCall(RuntimeContract.Calls.CreateTab.self) { workspace, _ in
          RuntimeContract.CreateTabParams(workspaceId: workspace, sessionId: target, parentSessionId: self.sessionId, title: String(localized: "session.tabs.defaultTitle", bundle: .lody))
        }
        switch result {
        case .created:
          self.attemptedTab = nil
          LodyShell.shared.openSessionFromExternal(target)
        case .rejected:
          self.attemptedTab = nil
          LodyToastOverlay.shared.show(message: String(localized: "session.tabs.failed", bundle: .lody), kind: "error")
        case .unknown:
          LodyToastOverlay.shared.show(message: String(localized: "session.tabs.unknown", bundle: .lody), kind: "info")
        }
      } catch {
        LodyToastOverlay.shared.show(message: String(localized: "session.tabs.unknown", bundle: .lody), kind: "info")
      }
    }
  }

  private func updateMoreMenu(_ session: SessionItem) {
    let deleting = SessionActions.isDeleting(source.state.workspaceId, sessionId)
    let more = moreButton
    more.accessibilityLabel = String(localized: "common.more", bundle: .lody)
    var changes: [UIMenuElement] = []
    if reviewable {
      changes.append(UIAction(title: String(localized: "workspaceChanges.title", bundle: .lody), image: UIImage(systemName: "plus.forwardslash.minus")) {
        [weak self] _ in self?.openWorkspaceChanges()
      })
    }
    var children: [UIMenuElement] = changes
    children.append(UIAction(title: String(localized: "session.action.find", bundle: .lody), image: UIImage(systemName: "magnifyingglass")) { [weak self] _ in
      self?.find(query: "", keyboard: true)
    })
    children.append(UIAction(title: String(localized: "session.tabs.new", bundle: .lody), image: UIImage(systemName: "plus"), attributes: creatingTab ? [.disabled] : []) { [weak self] _ in
      self?.createTab()
    })
    if !closedDirectoryTabs.isEmpty {
      children.append(UIAction(title: String(localized: "session.tabs.closed", bundle: .lody), image: UIImage(systemName: "clock.arrow.circlepath")) { [weak self] _ in
        self?.presentTabs(showClosed: true)
      })
    }
    children += sessionMenuItems(session)
    more.menu = UIMenu(children: children + [
      UIAction(title: String(localized: "session.action.share", bundle: .lody), image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in
        self?.perform("share")
      },
      UIAction(
        title: String(localized: String.LocalizationValue(session.archived ? "session.action.unarchive" : "session.action.archive"), bundle: .lody),
        image: UIImage(systemName: session.archived ? "tray.and.arrow.up" : "archivebox")
      ) { [weak self] _ in self?.perform("archive") },
      UIMenu(options: .displayInline, children: [
        UIAction(
          title: String(localized: String.LocalizationValue(deleting ? "session.delete.pending" : "session.action.delete"), bundle: .lody),
          image: UIImage(systemName: "trash"), attributes: deleting ? [.destructive, .disabled] : .destructive
        ) { [weak self] _ in self?.perform("delete") },
      ]),
    ])
    tabsButton.isHidden = directoryTabs.count <= 1
  }


  private func installPageHeader() {
    pageHeader.axis = .horizontal
    pageHeader.alignment = .center
    pageHeader.spacing = 8
    pageHeader.accessibilityIdentifier = "chat-page-header"
    for (button, symbol) in [(backButton, "chevron.backward"), (moreButton, "ellipsis")] {
      var configuration = UIButton.Configuration.glass()
      configuration.image = UIImage(systemName: symbol)
      configuration.baseForegroundColor = .label
      configuration.cornerStyle = .capsule
      button.configuration = configuration
      NSLayoutConstraint.activate([button.widthAnchor.constraint(equalToConstant: 44), button.heightAnchor.constraint(equalToConstant: 44)])
    }
    backButton.accessibilityIdentifier = "BackButton"
    backButton.accessibilityLabel = String(localized: "common.back", bundle: .lody)
    backButton.addAction(UIAction { [weak self] _ in self?.goBack() }, for: .touchUpInside)
    moreButton.accessibilityIdentifier = "chat-more"
    moreButton.showsMenuAsPrimaryAction = true
    var tabsConfiguration = UIButton.Configuration.glass()
    tabsConfiguration.image = tabsButton.image(for: .normal)
    tabsConfiguration.baseForegroundColor = .label
    tabsConfiguration.cornerStyle = .capsule
    tabsButton.configuration = tabsConfiguration
    sidebarButton.isHidden = sidebarAction == nil
    NSLayoutConstraint.activate([sidebarButton.widthAnchor.constraint(equalToConstant: 44), sidebarButton.heightAnchor.constraint(equalToConstant: 44)])
    for control in [sidebarButton, backButton, chat.titleButton, tabsButton, moreButton] { pageHeader.addArrangedSubview(control) }
    chat.titleButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
    chat.titleButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    // Let UIKit shape the existing soft scroll edge around the page-owned controls.
    let edge = UIScrollEdgeElementContainerInteraction()
    edge.scrollView = chat.collection
    edge.edge = .top
    pageHeader.addInteraction(edge)
    view.addSubview(pageHeader)
    chat.translatesAutoresizingMaskIntoConstraints = false
    pageHeader.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      pageHeader.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      pageHeader.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
      pageHeader.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
      pageHeader.heightAnchor.constraint(equalToConstant: chat.pageHeaderHeight),
      chat.topAnchor.constraint(equalTo: view.topAnchor),
      chat.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      chat.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      chat.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
  }

  var sidebarAnchorView: UIView { sidebarButton }

  func setSidebarItem(_ item: UIBarButtonItem?) {
    if let sidebarAction { sidebarButton.removeAction(sidebarAction, for: .touchUpInside) }
    sidebarAction = item?.primaryAction
    if let sidebarAction { sidebarButton.addAction(sidebarAction, for: .touchUpInside) }
    var configuration = UIButton.Configuration.glass()
    configuration.image = item?.image
    configuration.baseForegroundColor = .label
    configuration.cornerStyle = .capsule
    sidebarButton.configuration = configuration
    sidebarButton.accessibilityLabel = item?.accessibilityLabel
    sidebarButton.isHidden = item == nil
  }

  private func updatePageBack() {
    let canPop = (navigationController?.viewControllers.count ?? 0) > 1
    let canDismiss = navigationController?.presentingViewController != nil
    let collapsed = splitViewController?.isCollapsed == true
    backButton.isHidden = !canPop && !canDismiss && !collapsed
  }

  private func goBack() {
    guard let navigation = navigationController, navigation.transitionCoordinator == nil else { return }
    if navigation.viewControllers.count > 1 { navigation.popViewController(animated: true) }
    else if splitViewController?.isCollapsed == true { splitViewController?.show(.primary) }
    else if navigation.presentingViewController != nil { navigation.dismiss(animated: true) }
  }

  override func accessibilityPerformEscape() -> Bool {
    guard !backButton.isHidden else { return false }
    goBack()
    return true
  }

  private func wireEvents() {
    chat.onReconnect = { [weak self] _ in self?.feed?.reconnect() }
    chat.onTitleMenu = { [weak self] body in self?.titleMenuSelected(body["id"] as? String ?? "") }
    chat.onTitlePress = { [weak self] _ in self?.presentMachine() }
  }

  private func presentMachine() {
    let state = source.state
    guard let session = state.catalog.session(sessionId),
      let name = state.catalog.machineNames[session.machineId], !name.isEmpty,
      (parent ?? self).presentedViewController == nil else { return }
    let panel = UIHostingController(rootView: ChatMachinePanel(name: name, machine: .init(
      id: session.machineId, workspaceId: state.workspaceId,
      status: state.presence.status(of: session.machineId), members: Array(chat.members.values))))
    panel.modalPresentationStyle = .popover
    panel.preferredContentSize = CGSize(width: 320, height: 150)
    panel.popoverPresentationController?.sourceView = chat.tabsAnchorView
    panel.popoverPresentationController?.sourceRect = chat.tabsAnchorView.bounds
    (parent ?? self).present(panel, animated: true)
  }

  private func titleMenuSelected(_ id: String) {
    guard id.hasPrefix("tab:") else { return }
    let target = String(id.dropFirst(4))
    guard target != sessionId else { return }
    LodyShell.shared.openSessionFromExternal(target)
  }

  func perform(_ action: String) {
    actions.perform(action, row: sessionId, from: self)
  }

  func find(query: String, keyboard: Bool) {
    guard keyboard || !query.isEmpty else { return }
    findToken += 1
    chat.setFindRequest(Self.json(["token": findToken, "query": query, "keyboard": keyboard, "open": true]))
  }

  private func loadTabViews() {
    let state = source.state
    tabViewsLoad += 1
    let load = tabViewsLoad
    Task { [weak self] in
      let saved = await SessionSource.views(userId: state.userId, workspaceId: state.workspaceId)
      guard let self, self.source.state.key == state.key, self.tabViewsLoad == load else { return }
      let merged = saved.merging(self.tabViews) { max($0, $1) }
      guard merged != self.tabViews else { return }
      self.tabViews = merged
      self.render()
    }
  }

  private func markViewed() {
    guard browsingVisible, UIApplication.shared.applicationState == .active, view.window != nil else { return }
    let state = source.state
    guard let session = state.catalog.session(sessionId), !session.isTabClosed else { return }
    if persistsDraft {
      SessionTabSelection().remember(session, all: state.catalog.sessions, user: state.userId, workspace: state.workspaceId)
    }
    guard let message = session.lastMessageAt, message.isFinite, message > (tabViews[sessionId] ?? -.infinity) else { return }
    tabViews[sessionId] = message
    SessionSource.markViewed(userId: state.userId, workspaceId: state.workspaceId, sessionId: sessionId, at: message)
    if let panel = ChatTabsOverlay.shown(in: (parent ?? self).view) {
      panel.state.tabs = tabItems(directoryTabs)
    }
  }

  static func json(_ object: [String: Any]) -> String {
    (try? JSONSerialization.data(withJSONObject: object)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }
}

#if DEBUG
/// Offline UI evidence uses only owned views and public presentation-layer coordinates.
@MainActor private final class SessionHeaderTransitionProbe: NSObject {
  private weak var page: UIView?
  private let controls: [UIView]
  private let coordinator: UIViewControllerTransitionCoordinator
  private var link: CADisplayLink?
  private var samples: [[Double]] = []
  private var heldSince = CACurrentMediaTime()
  private var reportedHold = false

  init(page: UIView, controls: [UIView], coordinator: UIViewControllerTransitionCoordinator) {
    self.page = page
    self.controls = controls
    self.coordinator = coordinator
    super.init()
    let link = CADisplayLink(target: self, selector: #selector(sample))
    self.link = link
    link.add(to: .main, forMode: .common)
  }

  @objc private func sample() {
    guard let page, let window = page.window, samples.count < 600 else { return }
    let layer = page.layer.presentation() ?? page.layer
    let root = window.layer.presentation() ?? window.layer
    var values = [Double(coordinator.percentComplete), Double(layer.convert(.zero, to: root).x)]
    for control in controls {
      let child = control.layer.presentation() ?? control.layer
      values += [Double(child.convert(.zero, to: root).x), Double(child.convert(.zero, to: layer).x)]
    }
    if let previous = samples.last, abs(previous[0] - values[0]) > 0.001 { heldSince = CACurrentMediaTime() }
    samples.append(values)
    if !reportedHold, values[0] > 0.1, values[0] < 0.8, CACurrentMediaTime() - heldSince > 0.35 {
      reportedHold = true
      if let data = try? JSONSerialization.data(withJSONObject: ["sample": values]) {
        try? data.write(to: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lody-header-mid.json"), options: .atomic)
      }
    }
  }

  func finish(cancelled: Bool) {
    link?.invalidate()
    link = nil
    let result: [String: Any] = ["cancelled": cancelled, "samples": samples]
    if let data = try? JSONSerialization.data(withJSONObject: result) {
      try? data.write(to: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lody-header-transition.json"), options: .atomic)
    }
  }
}
#endif
