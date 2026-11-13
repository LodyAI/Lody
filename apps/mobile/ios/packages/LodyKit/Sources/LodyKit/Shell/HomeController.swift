import LodyCore
import LodyDesignSystem
import UIKit

@MainActor
final class HomeController: UIViewController, UISplitViewControllerDelegate, UIPopoverPresentationControllerDelegate {
  static weak var current: HomeController?
  let source: SessionSource
  private let split = UISplitViewController(style: .doubleColumn)
  private let primary = UINavigationController()
  private let secondary = UINavigationController()
  private let inspector = UINavigationController()
  private let inbox: InboxController
  /// iPhone tabs: each root page is built on first use and kept, so lists keep their scroll and state.
  private var selectedTab: HomeTab = .chats
  private var tabPages: [HomeTab: LodyPageController] = [:]
  private weak var schedules: SchedulesController?
  private let tabsHost = HomeTabsController()
  private let compactNavigation = HomeCompactNavigation()
  private var tabNavigations: [HomeTab: UINavigationController] = [:]
  private var compactTabsInstalled = false
  private var updatingTabContainer = false
  private var session: SessionController?
  private var scope = ""
  private var observers: [NSObjectProtocol] = []
  private var panelOpen = false
  private var layoutKey = ""
  private let parking = UIViewController()
  private lazy var foldHost = LodyFoldHost.make { [weak self] in self?.view.setNeedsLayout() }
  private var folded = false
  private var bookPosture = false
  private var foldPanes: [UIViewController] = []
  private var inspectorSheet: UIViewController?
  private var inspectorInSheet: Bool { inspectorSheet != nil }
  private var adaptingInspector = false
  private var updatingLayout = false
  private var listInPopover = false
  private var presentationRetry: Timer?
  private lazy var bookSidebarItem: UIBarButtonItem = {
    let item = UIBarButtonItem(image: UIImage(systemName: "sidebar.left"), primaryAction: UIAction { [weak self] _ in self?.showBookList() })
    item.accessibilityLabel = String(localized: "tabs.sessions", bundle: .lody)
    return item
  }()
  private lazy var sidebarItem = UIBarButtonItem(
    image: UIImage(systemName: "sidebar.left"), primaryAction: UIAction { [weak self] _ in self?.toggleSidebar() }
  )
  private var detailDetents: [Double] = [0.6, 1]
  private var layout: LodyHomeLayout {
    LodyHomeLayout(size: view.bounds.size, regular: traitCollection.horizontalSizeClass == .regular, book: bookPosture)
  }
  private var wide: Bool { layout.sideBySide }

  init(source: SessionSource = .live) {
    self.source = source; inbox = InboxController(source: source)
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError() }
  isolated deinit {
    presentationRetry?.invalidate()
    observers.forEach(NotificationCenter.default.removeObserver)
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    Self.current = self
    view.accessibilityIdentifier = "home"
    view.backgroundColor = .lodyBackground
    split.delegate = self
    split.primaryBackgroundStyle = .none
    split.preferredDisplayMode = .oneBesideSecondary
    split.showsSecondaryOnlyButton = true
    split.displayModeButtonVisibility = .never
    split.preferredPrimaryColumnWidth = 320
    split.preferredInspectorColumnWidthFraction = 0.45
    split.maximumInspectorColumnWidth = .greatestFiniteMagnitude
    primary.setViewControllers([tabPage(.chats)], animated: false)
    secondary.setViewControllers([placeholder()], animated: false)
    primary.view.accessibilityIdentifier = "ipad-panel"
    secondary.view.accessibilityIdentifier = "ipad-detail"
    inspector.view.accessibilityIdentifier = "ipad-inspector"
    for (controller, column) in zip([primary, secondary, inspector], [UISplitViewController.Column.primary, .secondary, .inspector]) {
      LodyShell.shared.configureNavigation(controller)
      split.setViewController(controller, for: column)
    }
    configureTabs()
    adopt(split)
    addChild(parking); parking.view.isHidden = true; view.addSubview(parking.view); parking.didMove(toParent: self)
    LodyFoldHost.observeHinge(on: view) { [weak self] book in
      guard let self, self.bookPosture != book else { return }
      self.bookPosture = book
      self.layoutColumns()
    }
    observers = source.changes.map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.scopeChanged() }
      }
    }
    observers.append(NotificationCenter.default.addObserver(forName: .lodyPageDidClose, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.invalidateLayout() }
    })
    scopeChanged()
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    invalidateLayout()
  }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    primary.traitOverrides.horizontalSizeClass = traitCollection.horizontalSizeClass
    (folded ? foldHost?.controller : split)?.view.frame = view.bounds
    view.accessibilityIdentifier = traitCollection.horizontalSizeClass == .regular ? "ipad-home" : "home"
    // Tabs exist only on compact width; a wide layout keeps Chats in the list column and shows
    // Schedules in the detail column.
    if traitCollection.horizontalSizeClass == .regular, selectedTab == .settings { selectTab(.chats) }
    updateTabContainer()
    layoutColumns()
  }
  private func scopeChanged() {
    tabsHost.canCreate = source.state.workspace?.resolvedMode == .plaintext
    let next = source.state.key
    guard next != scope else {
      if let session, !source.state.loading, source.state.catalog.session(session.sessionId) == nil { clearSession() }
      return
    }
    scope = next
    reset()
  }
  func reset() {
    for navigation in Set(tabNavigations.values).union([primary]) { navigation.popToRootViewController(animated: false) }
    if compactTabsInstalled { compactNavigation.popToRootViewController(animated: false) }
    let keepsSchedules = schedulesInDetail
    clearSession()
    if keepsSchedules { showSchedulesInDetail() }
  }
  /// Clear only the initiating conversation when Archive optimistically returns to Home.
  func returnToList(from controller: SessionController) {
    guard session === controller, !panelOpen else { return }
    clearSession()
  }
  private func clearSession() {
    leaveSchedulesDetail()
    session = nil
    closePanel()
    secondary.setViewControllers([placeholder()], animated: false)
    updateBookSidebar()
    inbox.list.selectedSessionId = ""
    tabNavigations.values.flatMap(\.viewControllers).flatMap(\.children).compactMap { $0 as? ProjectController }.forEach { $0.list.selectedSessionId = "" }
    layoutColumns()
    if split.isCollapsed { split.show(.primary) }
  }
  func openSession(_ id: String, query: String = "", choice: ModelChoice? = nil) {
    guard source.state.catalog.session(id) != nil else { return }
    if listInPopover {
      dismissBookList { [weak self] in self?.openSession(id, query: query, choice: choice) }
      return
    }
    leaveSchedulesDetail()
    if session?.sessionId != id {
      closePanel()
      let next = SessionController(sessionId: id, findQuery: query, choice: choice, source: source)
      session = next
      secondary.setViewControllers([page(next, title: "")], animated: false)
      updateBookSidebar()
    } else if !query.isEmpty { session?.find(query: query, keyboard: false) }
    inbox.list.selectedSessionId = id
    tabNavigations.values.flatMap(\.viewControllers).flatMap(\.children).compactMap { $0 as? ProjectController }.forEach { $0.list.selectedSessionId = id }
    layoutColumns()
    if !folded, !panelOpen { split.show(.secondary) }
  }
  func contains(_ controller: UIViewController) -> Bool {
    var ancestor: UIViewController? = controller
    while let current = ancestor {
      if current === self { return true }
      ancestor = current.parent
    }
    return false
  }
  func showPanel(_ content: UIViewController, title: String, from: UIViewController, push: Bool, detents: [Double], onClose: (() -> Void)? = nil) -> Bool {
    guard contains(from) || from.navigationController === inspector, session != nil else { return false }
    if layout == .compact, !push, !panelOpen { return false }
    let next = page(content, title: title)
    next.onClose = onClose
    if from.navigationController === inspector {
      inspector.pushViewController(next, animated: true)
    } else {
      clearInspector()
      detailDetents = detents
      inspector.setViewControllers([next], animated: false)
    }
    panelOpen = true
    invalidateLayout()
    layoutColumns()
    return true
  }
  func closePanel(from controller: UIViewController) -> Bool {
    guard controller.navigationController === inspector else { return false }
    if inspector.viewControllers.count > 1 { inspector.popViewController(animated: true) }
    else { closePanel() }
    return true
  }
  private func closePanel() {
    panelOpen = false
    if !inspectorInSheet { clearInspector() }
    invalidateLayout()
    layoutColumns()
  }
  private func clearInspector() {
    inspector.viewControllers.compactMap { $0 as? LodyPageController }.forEach { $0.markClosed() }
    inspector.setViewControllers([], animated: false)
  }
  func splitViewController(_ svc: UISplitViewController, topColumnForCollapsingToProposedTopColumn proposed: UISplitViewController.Column) -> UISplitViewController.Column {
    if panelOpen { return .inspector }
    return session == nil ? .primary : .secondary
  }
  func splitViewController(_ svc: UISplitViewController, willChangeTo displayMode: UISplitViewController.DisplayMode) {
    updateBookSidebar(sidebarShown: displayMode != .secondaryOnly)
  }
  func splitViewController(_ svc: UISplitViewController, didHide column: UISplitViewController.Column) {
    guard column == .inspector, layout == .compact, svc.isCollapsed, panelOpen,
          !inspectorInSheet, !adaptingInspector, !updatingLayout, !svc.isShowing(.inspector) else { return }
    panelOpen = false
    clearInspector()
    invalidateLayout()
  }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    if presentationController.presentedViewController === primary { restoreBookList(); return }
    guard let modal = inspectorSheet, presentationController.presentedViewController === modal else { return }
    LodyShell.shared.releaseNavigation(from: modal)
    inspectorSheet = nil
    panelOpen = false
    clearInspector()
    split.setViewController(inspector, for: .inspector)
    invalidateLayout()
  }
  func popoverPresentationControllerDidDismissPopover(_ popoverPresentationController: UIPopoverPresentationController) {
    restoreBookList()
  }
  private func placeholder() -> UIViewController {
    let controller = UIViewController()
    controller.view.backgroundColor = .lodyBackground
    controller.view.accessibilityIdentifier = "ipad-detail-placeholder"
    var configuration = UIContentUnavailableConfiguration.empty()
    configuration.image = UIImage(systemName: "bubble.left.and.bubble.right")
    configuration.text = String(localized: "ipad.detail.title", bundle: .lody)
    configuration.secondaryText = String(localized: "ipad.detail.message", bundle: .lody)
    controller.contentUnavailableConfiguration = configuration
    return controller
  }
  private func configureTabs() {
    tabsHost.onSelect = { [weak self] in self?.selectedTab = $0 }
    tabsHost.onCreate = { [weak self] in
      guard let self else { return }
      if self.selectedTab == .schedules { self.schedules?.newSchedule() } else { self.inbox.newSession() }
    }
    tabsHost.onDebug = { [weak self] in
      guard let self else { return }
      LodyShell.shared.openPage("debug", from: self.tabPages[.settings])
    }
    tabNavigations[.chats] = primary
    updateTabContainer()
  }

  /// Keep iPad's existing split/fold navigation; only compact Home uses system tabs.
  private func updateTabContainer() {
    let compact = traitCollection.horizontalSizeClass != .regular
    guard compact != compactTabsInstalled, !updatingTabContainer else { return }
    updatingTabContainer = true
    defer { updatingTabContainer = false }
    if folded { setFolded(false) }
    split.setViewController(nil, for: .primary)
    if compact {
      // Schedules leaves the regular-width detail column for its tab; the selection stays.
      if schedulesInDetail {
        schedules?.inDetailColumn = false
        secondary.setViewControllers([placeholder()], animated: false)
      }
      tabsHost.install { [weak self] destination in
        guard let self else { return UINavigationController() }
        return self.tabNavigation(destination)
      }
      tabsHost.show(selectedTab)
      compactNavigation.setViewControllers([tabsHost], animated: false)
      compactNavigation.setNavigationBarHidden(true, animated: false)
      split.setViewController(compactNavigation, for: .primary)
    } else {
      compactNavigation.setViewControllers([], animated: false)
      tabsHost.tabs = []
      split.setViewController(primary, for: .primary)
    }
    compactTabsInstalled = compact
    if !compact {
      if selectedTab == .schedules, session == nil { showSchedulesInDetail() } else { selectedTab = .chats }
      inbox.setDestination(selectedTab)
    }
  }

  private func tabNavigation(_ destination: HomeTab) -> UINavigationController {
    if let navigation = tabNavigations[destination] {
      // Regular width moved this tab's root into the detail column; take it back.
      if navigation.viewControllers.isEmpty { navigation.setViewControllers([tabPage(destination)], animated: false) }
      return navigation
    }
    let navigation = UINavigationController(rootViewController: tabPage(destination))
    LodyShell.shared.configureNavigation(navigation)
    tabNavigations[destination] = navigation
    return navigation
  }

  /// On iPhone, pages opened from a tab push over the whole tab controller, as conversations do.
  /// UIKit's hide-bottom-bar return draws the Liquid Glass tab bar's items before its glass,
  /// whereas the tab controller sliding back brings the bar in already composed.
  func pushTarget(for navigation: UINavigationController) -> UINavigationController? {
    guard compactTabsInstalled, tabNavigations.values.contains(where: { $0 === navigation }) else { return nil }
    return compactNavigation
  }

  func selectTab(_ next: HomeTab) {
    guard compactTabsInstalled else {
      // Regular width: the list column keeps Chats (the desktop sidebar); its bottom bar shows
      // Schedules in the detail column (the desktop main area) or returns to the conversation view.
      if listInPopover {
        dismissBookList { [weak self] in self?.selectTab(next) }
        return
      }
      switch next {
      case .settings: return
      case .schedules: showSchedulesInDetail()
      case .chats:
        if schedulesInDetail { clearSession() }
        else { primary.popToRootViewController(animated: !UIAccessibility.isReduceMotionEnabled) }
      }
      return
    }
    if next == selectedTab { tabNavigations[next]?.popToRootViewController(animated: !UIAccessibility.isReduceMotionEnabled) }
    selectedTab = next
    tabsHost.show(next)
  }

  private var schedulesInDetail: Bool {
    !compactTabsInstalled && selectedTab == .schedules && tabPages[.schedules].map { secondary.viewControllers.first === $0 } == true
  }

  /// Regular width: Schedules fills the detail column, as the desktop main area, while the list
  /// column keeps Chats. A root page has one parent, so it leaves its compact tab navigation here.
  private func showSchedulesInDetail() {
    let root = tabPage(.schedules)
    if let navigation = tabNavigations[.schedules] { navigation.setViewControllers([], animated: false) }
    session = nil
    closePanel()
    inbox.list.selectedSessionId = ""
    tabNavigations.values.flatMap(\.viewControllers).flatMap(\.children).compactMap { $0 as? ProjectController }.forEach { $0.list.selectedSessionId = "" }
    selectedTab = .schedules
    schedules?.inDetailColumn = true
    if secondary.viewControllers.first !== root { secondary.setViewControllers([root], animated: false) }
    inbox.setDestination(.schedules)
    updateBookSidebar()
    layoutColumns()
    if !folded { split.show(.secondary) }
  }

  /// A conversation or the empty detail replaces Schedules; the bottom bar returns to Chats.
  private func leaveSchedulesDetail() {
    guard !compactTabsInstalled, selectedTab == .schedules else { return }
    selectedTab = .chats
    schedules?.inDetailColumn = false
    inbox.setDestination(.chats)
  }

  func newSchedule() { schedules?.newSchedule() }

  private func tabPage(_ tab: HomeTab) -> LodyPageController {
    if let page = tabPages[tab] { return page }
    let (content, title): (UIViewController, String) = switch tab {
    case .chats: (inbox, "")
    // Schedules shares the Chats header (workspace capsule, search): no title.
    case .schedules: (schedulesPage(), "")
    case .settings: (SettingsController(), tab.title)
    }
    let next = page(content, title: title)
    next.hidesBottomBarWhenPushed = false
    tabPages[tab] = next
    return next
  }

  private func schedulesPage() -> SchedulesController {
    let page = SchedulesController(source: source)
    schedules = page
    return page
  }

  private func page(_ content: UIViewController, title: String) -> LodyPageController {
    LodyPageController(spec: .init(title: title, style: "push", animation: "slide", dismissible: true,
      headerShown: true, headerVariant: "transparent"), inSheet: false, content: content)
  }
  private func layoutColumns() {
    guard isViewLoaded, !adaptingInspector, !updatingLayout else { return }
    let mode = layout
    let key = "\(mode):\(panelOpen):\(split.isCollapsed):\(inspectorInSheet)"
    guard key != layoutKey else { return }
    layoutKey = key
    if listInPopover, mode != .book || !panelOpen {
      // Keep a creation/settings Sheet above the sidebar alive until it closes.
      if let child = primary.presentedViewController { retryAfterDismissal(of: child); return }
      dismissBookList { [weak self] in self?.invalidateLayout() }
      return
    }
    if inspectorInSheet, mode != .tall || !panelOpen {
      dismissInspectorForLayout()
      return
    }
    updatingLayout = true
    defer { updatingLayout = false }
    let useFold = mode == .book && foldHost != nil
    let frames = useFold != folded ? visiblePaneFrames() : []
    setFolded(useFold)
    updateInspectorChrome()
    updateBookSidebar()
    if folded {
      placeFoldPanes()
      animatePaneFrames(from: frames)
      return
    }
    split.preferredSplitBehavior = wide ? .tile : .overlay
    if panelOpen, mode == .tall {
      split.hide(.inspector)
      split.hide(.primary)
      if !inspectorInSheet {
        split.setViewController(nil, for: .inspector)
        if let modal = LodyShell.shared.presentNavigation(inspector, detents: detailDetents) {
          inspectorSheet = modal
          modal.presentationController?.delegate = self
        } else { split.setViewController(inspector, for: .inspector) }
      }
    } else if panelOpen {
      split.show(.inspector)
      if wide { split.hide(.primary) }
    }
    else {
      split.hide(.inspector)
      if wide { split.show(.primary) }
      else if !split.isCollapsed { split.hide(.primary) }
    }
    animatePaneFrames(from: frames)
  }

  private func invalidateLayout() { layoutKey = ""; if isViewLoaded { view.setNeedsLayout() } }

  private func updateBookSidebar(sidebarShown: Bool? = nil) {
    guard isViewLoaded, let item = secondary.viewControllers.first?.navigationItem else { return }
    let header = LodyNavigationHeader.of(item)
    var toggle: UIBarButtonItem?
    if folded {
      toggle = panelOpen ? bookSidebarItem : nil
    } else if !split.isCollapsed, traitCollection.horizontalSizeClass == .regular {
      toggle = sidebarItem
      let shown = sidebarShown ?? (split.displayMode != .secondaryOnly)
      let key = shown ? "ipad.sidebar.hide" : "ipad.sidebar.show"
      sidebarItem.accessibilityLabel = String(localized: String.LocalizationValue(key), bundle: .lody)
    }
    if let session {
      session.setSidebarItem(toggle)
      return
    }
    if let toggle {
      if header.leftItems != [toggle] { header.leftItems = [toggle] }
    } else if let current = header.leftItems, current == [bookSidebarItem] || current == [sidebarItem] {
      header.leftItems = nil
      item.leftBarButtonItems = nil
    }
  }

  private func toggleSidebar() {
    if split.displayMode == .secondaryOnly { split.show(.primary) } else { split.hide(.primary) }
  }

  private func showBookList() {
    guard folded, panelOpen, !listInPopover else { return }
    release(primary)
    let anchor = session?.sidebarAnchorView
    if LodyShell.shared.presentNavigation(primary, popoverFrom: anchor == nil ? bookSidebarItem : nil,
      sourceView: anchor, sourceRect: anchor?.bounds) != nil {
      listInPopover = true
      primary.viewControllers.compactMap { $0 as? LodyPageController }.forEach { $0.isRehosting = true }
      primary.popoverPresentationController?.delegate = self
    } else { park(primary) }
  }

  private func dismissBookList(completion: @escaping () -> Void) {
    if primary.presentingViewController == nil {
      restoreBookList()
      completion()
      return
    }
    primary.dismiss(animated: false) { [weak self] in
      self?.restoreBookList()
      completion()
    }
  }

  private func restoreBookList() {
    guard listInPopover else { return }
    listInPopover = false
    primary.modalPresentationStyle = .automatic
    primary.viewControllers.compactMap { $0 as? LodyPageController }.forEach { $0.isRehosting = false }
    park(primary)
    invalidateLayout()
  }

  private func park(_ controller: UIViewController) {
    release(controller)
    parking.addChild(controller); parking.view.addSubview(controller.view); controller.didMove(toParent: parking)
  }

  private func updateInspectorChrome() {
    guard let root = inspector.viewControllers.first else { return }
    if layout == .compact { root.navigationItem.leftBarButtonItem = nil; return }
    let close = root.navigationItem.leftBarButtonItem ?? UIBarButtonItem(image: UIImage(systemName: "xmark"),
      primaryAction: UIAction { [weak self] _ in self?.closePanel() })
    if layout == .tall {
      close.accessibilityLabel = String.localizedStringWithFormat(String(localized: "accessibility.closeSheet", bundle: .lody), root.title ?? "")
    } else { close.accessibilityLabel = String(localized: "accessibility.closePanel", bundle: .lody) }
    root.navigationItem.leftBarButtonItem = close
  }

  private func dismissInspectorForLayout() {
    guard let modal = inspectorSheet else { return }
    // A transient form above the detail keeps its own presentation until it closes.
    if let child = modal.presentedViewController ?? inspector.presentedViewController { retryAfterDismissal(of: child); return }
    if let transition = modal.transitionCoordinator {
      adaptingInspector = true
      let coordinated = transition.animate(alongsideTransition: nil) { [weak self] _ in
        self?.adaptingInspector = false
        self?.invalidateLayout()
      }
      if coordinated { return }
      adaptingInspector = false
    }
    adaptingInspector = true
    let pages = inspector.viewControllers.compactMap { $0 as? LodyPageController }
    pages.forEach { $0.isRehosting = panelOpen }
    let reattach = { [weak self] in
      LodyShell.shared.releaseNavigation(from: modal)
      pages.forEach { $0.isRehosting = false }
      guard let self else { return }
      self.inspectorSheet = nil
      self.adaptingInspector = false
      if !self.panelOpen { self.clearInspector() }
      self.split.setViewController(self.inspector, for: .inspector)
      self.invalidateLayout()
    }
    if modal.presentingViewController == nil { reattach() }
    else { modal.dismiss(animated: false, completion: reattach) }
  }

  private func retryAfterDismissal(of controller: UIViewController) {
    guard presentationRetry == nil else { return }
    // UIKit-owned Share/alert controllers have no LodyPage close notification.
    // Watch only while a modal blocks rehosting; never dismiss that modal for layout.
    let timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self, weak controller] _ in
      MainActor.assumeIsolated {
        guard controller?.presentingViewController == nil else { return }
        self?.presentationRetry?.invalidate()
        self?.presentationRetry = nil
        self?.invalidateLayout()
      }
    }
    timer.tolerance = 0.1
    presentationRetry = timer
  }

  private func visiblePaneFrames() -> [(UIView, CGRect)] {
    guard view.window != nil, !UIAccessibility.isReduceMotionEnabled else { return [] }
    return [primary, secondary, inspector].compactMap { controller in
      guard controller.view.window != nil, !controller.view.isHidden else { return nil }
      let frame = controller.view.convert(controller.view.bounds, to: view)
      return frame.intersects(view.bounds) ? (controller.view, frame) : nil
    }
  }

  private func animatePaneFrames(from frames: [(UIView, CGRect)]) {
    guard !frames.isEmpty else { return }
    view.layoutIfNeeded()
    let panes = frames.compactMap { pane, previous -> UIView? in
      guard pane.window != nil else { return nil }
      let target = pane.convert(pane.bounds, to: view)
      guard target.width > 0, target.height > 0 else { return nil }
      pane.transform = CGAffineTransform(translationX: previous.midX - target.midX, y: previous.midY - target.midY)
        .scaledBy(x: previous.width / target.width, y: previous.height / target.height)
      return pane
    }
    UIView.animate(withDuration: 0.32, delay: 0, options: [.beginFromCurrentState, .curveEaseInOut, .allowUserInteraction]) {
      panes.forEach { $0.transform = .identity }
    }
  }
  private func setFolded(_ value: Bool) {
    guard value != folded, let foldHost else { return }
    release(folded ? foldHost.controller : split)
    if value {
      for column in [UISplitViewController.Column.primary, .secondary, .inspector] { split.setViewController(nil, for: column) }
    } else {
      foldHost.show(leading: nil, trailing: nil); foldPanes = []
      for column in [primary, secondary, inspector] where column.parent === parking { release(column) }
      for (controller, column) in zip([primary, secondary, inspector], [UISplitViewController.Column.primary, .secondary, .inspector]) where controller !== inspector || !inspectorInSheet {
        split.setViewController(controller, for: column)
      }
    }
    folded = value
    adopt(value ? foldHost.controller : split)
  }
  private func placeFoldPanes() {
    guard let foldHost else { return }
    let panes: [UIViewController] = panelOpen ? [secondary, inspector] : [primary, secondary]
    guard panes != foldPanes else { return }
    foldHost.show(leading: nil, trailing: nil)
    for column in [primary, secondary, inspector] where !panes.contains(column) {
      park(column)
    }
    for pane in panes where pane.parent === parking { release(pane) }
    foldHost.show(leading: panes[0], trailing: panes[1]); foldPanes = panes
  }
  private func adopt(_ controller: UIViewController) {
    addChild(controller); view.insertSubview(controller.view, at: 0); controller.view.frame = view.bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]; controller.didMove(toParent: self)
  }
  private func release(_ controller: UIViewController) {
    guard controller.parent != nil else { return }
    controller.willMove(toParent: nil); controller.view.removeFromSuperview(); controller.removeFromParent()
  }
}
