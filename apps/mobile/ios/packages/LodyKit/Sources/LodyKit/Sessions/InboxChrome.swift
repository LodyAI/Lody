import LodyDesignSystem
import SwiftUI
import UIKit

@MainActor
final class InboxChrome {
  struct Model {
    var accountEmail = ""
    var workspaces: [AuthWorkspace]
    var selected: AuthWorkspace?
    var devices: InboxDevices
    var connection: HomeSyncState = .live
  }

  var selectWorkspace: ((String) -> Void)?
  var openSettings: (() -> Void)?
  var openDebug: (() -> Void)?
  var newSession: (() -> Void)?
  var searchChanged: ((String) -> Void)?
  /// Regular width: the Home destination this page is, and how to switch to another (`InboxPadBar`).
  var destination: HomeTab = .chats { didSet { padBar.destination = destination } }
  var selectDestination: ((HomeTab) -> Void)?
  /// Regular width can host a page (Schedules) in the detail column, as the desktop main area:
  /// it keeps search and its view menu under a plain title, without the capsule or bottom bar.
  private(set) var detailTitle: String?
  private var lastModel: Model?
  /// Replaces the Chats view menu (the Projects tab has its own choices).
  var compactMenu: (() -> UIMenu)?
  /// Replaces the view menu on every size class for pages with their own choices (Schedules).
  var pageMenu: (() -> UIMenu)?

  private weak var host: UIViewController?
  private var header: LodyNavigationHeader?
  private let workspace = LodyMenuButton(frame: .zero)
  private let search = LodyNavigationSearch()
  private let padBar = InboxPadBar()
  private weak var content: UIViewController?
  private lazy var workspaceSlot = InboxBarSlot(workspace)
  private var workspaceItem: UIBarButtonItem?
  private var filterItem: UIBarButtonItem?
  private var toolbar: [UIBarButtonItem] = []
  private var naturalWidth: CGFloat = 44
  private var waitingForTransition = false
  /// While the expanded search field is active, the workspace capsule steps aside for it.
  private var searching = false
  private let syncPill = UIHostingConfiguration { HomeSyncPill(state: nil) }.margins(.all, 0).makeContentView()
  private var workspaceCollapsed = false
  private var syncState: HomeSyncState = .live
  private var syncShown: HomeSyncPill.Shown?
  private var recoveryTask: Task<Void, Never>?
  private var sizeClassChanges: (any UITraitChangeRegistration)?

  init(searchPlaceholder: String = String(localized: "search.field.placeholder", bundle: .lody)) {
    workspace.accessibilityIdentifier = "workspace-menu"
    workspace.selected = { [weak self] id in self?.selected(id) }
    workspace.sized = { [weak self] width in
      self?.naturalWidth = width
      self?.layout()
    }
    // Every width: a search button that expands into the field (iOS 26 integratedButton).
    // No toolbar integration: with a toolbar-less page UIKit otherwise drops the button to the
    // bottom edge, under the system tab bar. `update` places it in the trailing nav items instead.
    search.configure(LodyNavigationSearch.Config(
      placeholder: searchPlaceholder, placement: "integratedButton", hideWhenScrolling: false,
      allowToolbarIntegration: false
    ))
    search.emit = { [weak self] event, text in
      guard let self else { return }
      switch event {
      case "change": self.searchChanged?(text)
      case "focus": self.setSearching(true)
      case "cancel": self.setSearching(false)
      case "blur" where text.isEmpty: self.setSearching(false)
      default: break
      }
    }
    padBar.select = { [weak self] tab in self?.selectDestination?(tab) }
    padBar.openSettings = { [weak self] in self?.openSettings?() }
    padBar.openDebug = { [weak self] in self?.openDebug?() }
    padBar.create = { [weak self] in self?.newSession?() }
  }

  func attach(to host: UIViewController, content: UIViewController, scrollView: UIScrollView) {
    if let sizeClassChanges { self.host?.unregisterForTraitChanges(sizeClassChanges) }
    self.host = host
    self.content = content
    header = LodyNavigationHeader.of(host.navigationItem)
    padBar.attachScrollEdge(to: scrollView)
    sizeClassChanges = host.registerForTraitChanges([UITraitHorizontalSizeClass.self]) { [weak self] (_: UIViewController, _: UITraitCollection) in
      guard let self, let model = self.lastModel else { return }
      self.update(model)
    }
  }

  /// Called from the content's `viewIsAppearing`: the first point the page is in a window, so the
  /// search placement item withheld by an earlier off-screen `update` can be placed.
  func hostIsAppearing() {
    guard let lastModel else { return }
    update(lastModel)
  }

  func update(_ model: Model?) {
    guard let host, let header else { return }
    guard let model else {
      lastModel = nil
      clear()
      return
    }
    lastModel = model
    let name = model.selected?.name ?? String(localized: "common.workspace", bundle: .lody)
    workspace.setAccessibilityName(
      "\(String.localizedStringWithFormat(String(localized: "inbox.workspaceSwitch.accessibility", bundle: .lody), String(describing: name))), \(model.devices.summary)"
    )
    var avatar = LodyMenuAvatar()
    avatar.text = String(name.prefix(1))
    avatar.image = model.selected?.image ?? ""
    workspace.setAvatar(avatar)
    workspace.setLabel(name)
    // The capsule keeps to logo + name; connection state floats in the centre pill instead.
    updateSync(model.connection)
    workspace.setAccountEmail(model.accountEmail)
    workspace.setItems(menuItems(model))
    padBar.canCreate = model.selected?.resolvedMode == .plaintext
    layout()
    let left = [workspaceItem ?? UIBarButtonItem(customView: workspaceSlot)]
    let filter = filterItem ?? UIBarButtonItem(image: UIImage(systemName: "line.3.horizontal.decrease"), menu: nil)
    filter.tintColor = .label
    filter.accessibilityLabel = String(localized: "inbox.settings.section.view", bundle: .lody)
    // Every size class shares the Chats view menu (grouping, scope, row details, archive).
    filter.menu = pageMenu?() ?? compactMenu?() ?? viewMenu()
    if header.search !== search { header.search = search }
    // Destinations, Settings and create sit in the iPhone tab bar, or in `InboxPadBar` at regular width.
    // Right items run from the trailing edge: search, then the view menu (design).
    // UIKit throws NSInvalidArgumentException ("searchBarPlacementBarButtonItem is only supported in
    // UIToolbar") when the item enters the bar of a page that is not yet on screen: a cold launch's
    // sign-in restore renders Home ~170 ms in, before it appears, and aborted on every launch. iPadOS 26
    // throws even on screen, so only a compact iPhone page places it, and only once in a window;
    // `hostIsAppearing` and size class changes re-run this. Elsewhere UIKit places the search itself.
    let placesSearch = host.traitCollection.userInterfaceIdiom == .phone
      && host.traitCollection.horizontalSizeClass == .compact
      && host.viewIfLoaded?.window != nil
    let right = placesSearch ? [filter, host.navigationItem.searchBarPlacementBarButtonItem] : [filter]
    (workspaceItem, filterItem) = (left[0], filter)
    let shownLeft = searching || detailTitle != nil ? [] : left
    host.navigationItem.title = detailTitle
    if header.leftItems ?? [] != shownLeft { header.leftItems = shownLeft.isEmpty ? nil : shownLeft }
    if header.rightItems != right { header.rightItems = right }
    showToolbar()
  }

  /// Moves the page between the list column (or a tab) and the regular-width detail column.
  func setDetailTitle(_ title: String?) {
    guard detailTitle != title else { return }
    detailTitle = title
    if detailTitle != nil, let host { showSync(nil, in: host) }
    update(lastModel)
  }

  func detach() {
    clear()
    if let sizeClassChanges { host?.unregisterForTraitChanges(sizeClassChanges) }
    sizeClassChanges = nil
    header = nil
    host = nil
  }

  private func clear() {
    workspace.setAccountEmail("")
    workspace.setItems([])
    guard let header else { return }
    if let item = workspaceItem, header.leftItems == [item] { header.leftItems = nil }
    if let right = header.rightItems, right.contains(where: { $0 === filterItem || $0 === host?.navigationItem.searchBarPlacementBarButtonItem }) {
      header.rightItems = nil
    }
    if header.search === search { header.search = nil }
    if let host, host.navigationItem.titleView === syncPill { host.navigationItem.titleView = nil }
    recoveryTask?.cancel()
    showPadBar(false)
    if let host, !toolbar.isEmpty, host.toolbarItems ?? [] == toolbar {
      host.setToolbarItems(nil, animated: false)
      if let navigation = host.navigationController, navigation.topViewController === host {
        navigation.setToolbarHidden(true, animated: false)
      }
    }
  }

  private func showToolbar() {
    guard let host else { return }
    // Even a nonanimated item update can replace UIKit's retiring glass during push/pop.
    if let transition = host.navigationController?.transitionCoordinator {
      guard !waitingForTransition else { return }
      waitingForTransition = true
      transition.animate(alongsideTransition: nil) { [weak self] _ in
        self?.waitingForTransition = false
        self?.showToolbar()
      }
      return
    }
    let regular = host.traitCollection.horizontalSizeClass == .regular
    showPadBar(regular && detailTitle == nil)
    // iPhone's search lives in the navigation bar and new chat in the system tab bar, so no bottom toolbar on either layout.
    if !toolbar.isEmpty, host.toolbarItems ?? [] == toolbar { host.setToolbarItems(nil, animated: false) }
    toolbar = []
    if let navigation = host.navigationController, navigation.topViewController === host {
      navigation.setToolbarHidden(true, animated: false)
    }
  }

  func layout() {
    guard let host else { return }
    let insets = host.view.safeAreaInsets
    let width = host.view.bounds.width - insets.left - insets.right
    let limit = max(44, width - 192)
    workspaceSlot.size = CGSize(width: min(naturalWidth, limit), height: 44)
  }

  private func showPadBar(_ shown: Bool) {
    content?.additionalSafeAreaInsets.bottom = shown ? InboxPadBar.height + 10 : 0
    guard shown, let host else {
      padBar.removeFromSuperview()
      return
    }
    guard padBar.superview !== host.view else { return }
    padBar.removeFromSuperview()
    padBar.translatesAutoresizingMaskIntoConstraints = false
    host.view.addSubview(padBar)
    NSLayoutConstraint.activate([
      padBar.leadingAnchor.constraint(equalTo: host.view.safeAreaLayoutGuide.leadingAnchor),
      padBar.trailingAnchor.constraint(equalTo: host.view.safeAreaLayoutGuide.trailingAnchor),
      padBar.bottomAnchor.constraint(equalTo: host.view.keyboardLayoutGuide.topAnchor),
    ])
  }

  /// The switcher lists only workspaces; devices and workspace editing live in Settings.
  private func menuItems(_ model: Model) -> [LodyMenuItem] {
    model.workspaces.map { workspace in
      var item = LodyMenuItem()
      item.id = workspace.id
      item.title = workspace.name
      item.encrypted = workspace.resolvedMode == .e2ee
      item.retrySelection = workspace.resolvedMode != .plaintext
      item.selected = workspace.id == model.selected?.id
      // Each workspace shows its real logo, its initial until that loads (as the capsule).
      item.photo = workspace.image ?? ""
      item.monogram = String(workspace.name.prefix(1)).uppercased()
      return item
    }
  }

  private func selected(_ id: String) {
    selectWorkspace?(id)
  }

  private func setSearching(_ value: Bool) {
    guard searching != value, let header else { return }
    searching = value
    guard let workspaceItem else { return }
    header.leftItems = value || detailTitle != nil ? nil : [workspaceItem]
  }

  /// Chats view menu: toggles for what each chat row's second line shows. Built when the menu
  /// opens (uncached) so the checkmarks always match the stored choice, and a tap closes the menu:
  /// keeping it open never redrew the checkmark (UIKit shows a copy of the actions), so the
  /// setting changed while the check stayed put.
  private func viewMenu() -> UIMenu {
    let options: [(ChatRowDetails, String, String)] = [
      (.project, "home.view.project", "folder"),
      (.pullRequest, "home.view.pullRequest", "arrow.triangle.pull"),
      (.branch, "home.view.branch", "arrow.triangle.branch"),
    ]
    let toggles: [UIMenuElement] = [UIDeferredMenuElement.uncached { completion in
      let current = ChatRowDetails.stored
      completion(options.map { option, key, symbol in
        UIAction(
          title: String(localized: String.LocalizationValue(key), bundle: .lody), image: UIImage(systemName: symbol),
          state: current.contains(option) ? .on : .off
        ) { _ in
          var next = ChatRowDetails.stored
          if next.contains(option) { next.remove(option) } else { next.insert(option) }
          ChatRowDetails.store(next)
        }
      })
    }]
    // Single choice; uncached so the check follows the stored value after each pick.
    let groupings = UIDeferredMenuElement.uncached { completion in
      let current = HomeGrouping.stored
      completion([(HomeGrouping.time, "clock"), (.project, "folder"), (.status, "circle.dashed")].map { grouping, symbol in
        UIAction(
          title: String(localized: String.LocalizationValue("home.grouping." + grouping.rawValue), bundle: .lody),
          image: UIImage(systemName: symbol), state: current == grouping ? .on : .off
        ) { _ in HomeGrouping.store(grouping) }
      })
    }
    let scopes = UIDeferredMenuElement.uncached { completion in
      let current = HomeScope.stored
      completion([(HomeScope.mine, "person"), (.team, "person.2")].map { scope, symbol in
        UIAction(
          title: String(localized: String.LocalizationValue("home.scope." + scope.rawValue), bundle: .lody),
          image: UIImage(systemName: symbol), state: current == scope ? .on : .off
        ) { _ in HomeScope.store(scope) }
      })
    }
    // UIKit caps a menu's height and gives no API to raise it, so the single-choice sections lay
    // their options side by side (.medium) to keep every row on screen without scrolling.
    let scopeMenu = UIMenu(title: String(localized: "home.view.scope", bundle: .lody), options: [.displayInline, .singleSelection], children: [scopes])
    scopeMenu.preferredElementSize = .medium
    let groupingMenu = UIMenu(title: String(localized: "home.view.grouping", bundle: .lody), options: [.displayInline, .singleSelection], children: [groupings])
    groupingMenu.preferredElementSize = .medium
    return UIMenu(
      children: [
        scopeMenu,
        groupingMenu,
        UIMenu(title: String(localized: "home.view.details", bundle: .lody), options: .displayInline, children: toggles),
        Self.archiveToggle(),
      ]
    )
  }

  /// Centre pill, as on the web mobile header: syncing / connecting, plus a brief "connected" flash on recovery.
  private func updateSync(_ next: HomeSyncState) {
    guard let host else { return }
    let previous = syncState
    syncState = next
    if next == .live, previous != .live {
      recoveryTask?.cancel()
      showSync(.recovered, in: host)
      recoveryTask = Task { [weak self] in
        try? await Task.sleep(for: .milliseconds(1200))
        guard let self, !Task.isCancelled, self.syncState == .live, let host = self.host else { return }
        self.showSync(nil, in: host)
      }
      return
    }
    if next != .live { recoveryTask?.cancel() }
    let shown: HomeSyncPill.Shown? = switch next {
    case .live: syncShown == .recovered ? .recovered : nil
    case .syncing: .syncing
    case .connecting: .connecting
    }
    showSync(shown, in: host)
  }

  private func showSync(_ shown: HomeSyncPill.Shown?, in host: UIViewController) {
    syncShown = shown
    syncPill.configuration = UIHostingConfiguration { HomeSyncPill(state: shown) }.margins(.all, 0)
    syncPill.backgroundColor = .clear
    syncPill.isUserInteractionEnabled = false
    syncPill.accessibilityIdentifier = "home-sync-status"
    let collapsed = shown != nil && detailTitle == nil
    let animate = workspaceCollapsed != collapsed && host.viewIfLoaded?.window != nil && !UIAccessibility.isReduceMotionEnabled
    workspaceCollapsed = collapsed
    let bar = host.navigationController?.navigationBar
    bar?.layoutIfNeeded()
    let changes = {
      self.workspace.setLabelHidden(collapsed)
      host.navigationItem.titleView = collapsed ? self.syncPill : nil
      bar?.layoutIfNeeded()
    }
    if animate {
      let fadeDuration = collapsed ? LodyMotion.base : LodyMotion.slower
      let layoutDuration = collapsed ? LodyMotion.slow : LodyMotion.slower
      UIView.transition(with: workspace, duration: fadeDuration, options: [.transitionCrossDissolve, .allowAnimatedContent, .beginFromCurrentState]) {
        UIView.animate(withDuration: layoutDuration, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState], animations: changes)
      }
    } else { changes() }
  }

  /// The Archived switch: on, the list shows only archived chats on a darker, greyer page.
  /// Uncached so its checkmark follows the current mode each time the menu opens.
  private static func archiveToggle() -> UIMenuElement {
    UIMenu(options: .displayInline, children: [UIDeferredMenuElement.uncached { completion in
      let shown = HomeArchive.shown
      completion([UIAction(
        title: String(localized: "home.view.archived", bundle: .lody), image: UIImage(systemName: "archivebox"),
        state: shown ? .on : .off
      ) { _ in HomeArchive.set(!shown) }])
    }])
  }
}

// UIKit sizes bar custom views to the bar's height; the control keeps its 44 pt target and overflows the slot.
private final class InboxBarSlot: UIView {
  private let content: UIView
  private var width: NSLayoutConstraint!
  private var height: NSLayoutConstraint!
  var size = CGSize(width: 44, height: 44) {
    didSet {
      width.constant = size.width
      height.constant = size.height
      setNeedsLayout()
    }
  }

  init(_ content: UIView) {
    self.content = content
    super.init(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
    translatesAutoresizingMaskIntoConstraints = false
    addSubview(content)
    width = widthAnchor.constraint(equalToConstant: 44)
    height = heightAnchor.constraint(equalToConstant: 44)
    NSLayoutConstraint.activate([width, height])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func layoutSubviews() {
    super.layoutSubviews()
    content.bounds = CGRect(origin: .zero, size: size)
    content.center = CGPoint(x: bounds.midX, y: bounds.midY)
  }
}
