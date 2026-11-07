import LodyDesignSystem
import SwiftUI
import UIKit

@MainActor
final class InboxChrome {
  struct Model {
    var workspaces: [AuthWorkspace]
    var selected: AuthWorkspace?
    var devices: InboxDevices
    var running = 0
    var mode: Int
    var sort: InboxSort
    var connection: HomeSyncState = .live
  }

  var selectWorkspace: ((String) -> Void)?
  var editWorkspace: (() -> Void)?
  var setView: ((Int) -> Void)?
  var setSort: ((InboxSort) -> Void)?
  var openSettings: (() -> Void)?
  var openDebug: (() -> Void)?
  var newSession: (() -> Void)?
  var searchChanged: ((String) -> Void)?
  /// Replaces the iPhone view menu (the Projects tab has its own choices).
  var compactMenu: (() -> UIMenu)?

  static let editId = "workspace:edit"
  private static let views = [
    (mode: 0, key: "inbox.settings.view.projects", icon: "folder"),
    (mode: 1, key: "inbox.settings.view.activity", icon: "clock"),
    (mode: 2, key: "inbox.settings.view.chat", icon: "bubble.left"),
  ]
  private static let sorts: [(sort: InboxSort, icon: String)] = [
    (.name, "textformat"), (.activity, "clock"), (.urgency, "exclamationmark.circle"),
  ]

  private weak var host: UIViewController?
  private var header: LodyNavigationHeader?
  private let workspace = LodyMenuButton(frame: .zero)
  private let settings = LodySymbolButton(frame: .zero)
  private let search = LodyNavigationSearch()
  private let padBar = InboxPadBar()
  private weak var content: UIViewController?
  private lazy var workspaceSlot = InboxBarSlot(workspace)
  private lazy var settingsSlot = InboxBarSlot(settings)
  private var workspaceItem: UIBarButtonItem?
  private var settingsItem: UIBarButtonItem?
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

  init() {
    workspace.accessibilityIdentifier = "workspace-menu"
    workspace.selected = { [weak self] id in self?.selected(id) }
    workspace.sized = { [weak self] width in
      self?.naturalWidth = width
      self?.layout()
    }
    settings.setSymbol("gearshape")
    settings.setAccessibilityName(String(localized: "tabs.settings", bundle: .lody))
    settings.setLongPress(true)
    settings.pressed = { [weak self] in self?.openSettings?() }
    settings.held = { [weak self] in self?.openDebug?() }
    // iPhone: a search button that expands into the field (iOS 26 integratedButton); iPad uses padBar.
    // No toolbar integration: with a toolbar-less page UIKit otherwise drops the button to the
    // bottom edge, under the system tab bar. `update` places it in the trailing nav items instead.
    search.configure(LodyNavigationSearch.Config(
      placeholder: String(localized: "search.field.placeholder", bundle: .lody), placement: "integratedButton", hideWhenScrolling: false,
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
    padBar.searchChanged = { [weak self] text in self?.searchChanged?(text) }
    padBar.create = { [weak self] in self?.newSession?() }
  }

  func attach(to host: UIViewController, content: UIViewController, scrollView: UIScrollView) {
    self.host = host
    self.content = content
    header = LodyNavigationHeader.of(host.navigationItem)
    padBar.attachScrollEdge(to: scrollView)
  }

  func update(_ model: Model?) {
    guard let host, let header else { return }
    guard let model else {
      clear()
      return
    }
    let name = model.selected?.name ?? String(localized: "common.workspace", bundle: .lody)
    workspace.setAccessibilityName(
      "\(String.localizedStringWithFormat(String(localized: "inbox.workspaceSwitch.accessibility", bundle: .lody), String(describing: name))), \(model.devices.summary)"
    )
    var avatar = LodyMenuAvatar()
    avatar.text = String(name.prefix(1))
    avatar.image = model.selected?.image ?? ""
    workspace.setAvatar(avatar)
    workspace.setLabel(name)
    let running = model.running > 0
      ? String.localizedStringWithFormat(String(localized: "inbox.header.running", bundle: .lody), model.running)
      : ""
    // iPhone keeps the capsule to logo + name; connection state floats in the centre pill instead.
    let compactLayout = host.traitCollection.horizontalSizeClass != .regular
    workspace.setDetail(compactLayout ? "" : [model.devices.summary, running].filter { !$0.isEmpty }.joined(separator: " · "))
    updateSync(model.connection, compact: compactLayout)
    workspace.setItems(menuItems(model))
    layout()
    let regular = host.traitCollection.horizontalSizeClass == .regular
    let left = [workspaceItem ?? UIBarButtonItem(customView: workspaceSlot)]
    let filter = filterItem ?? UIBarButtonItem(image: UIImage(systemName: "line.3.horizontal.decrease"), menu: nil)
    filter.tintColor = .label
    filter.accessibilityLabel = String(localized: "inbox.settings.section.view", bundle: .lody)
    filter.menu = regular ? filterMenu(mode: model.mode, sort: model.sort) : (compactMenu?() ?? compactViewMenu())
    let settingsItem = self.settingsItem ?? UIBarButtonItem(customView: settingsSlot)
    // iPad keeps integrated search in the navigation bar, so the sidebar hosts its own bottom field.
    if regular, header.search === search { header.search = nil }
    if !regular, header.search !== search { header.search = search }
    // iPhone reaches Settings from the bottom tabs; iPad keeps the gear beside the view menu.
    // Right items run from the trailing edge: iPhone shows search, then the view menu (design).
    let right = regular ? [settingsItem, filter] : [filter, host.navigationItem.searchBarPlacementBarButtonItem]
    (workspaceItem, self.settingsItem, filterItem) = (left[0], settingsItem, filter)
    let shownLeft = searching && !regular ? [] : left
    if header.leftItems ?? [] != shownLeft { header.leftItems = shownLeft.isEmpty ? nil : shownLeft }
    if header.rightItems != right { header.rightItems = right }
    showToolbar()
  }

  func detach() {
    clear()
    header = nil
    host = nil
  }

  private func clear() {
    guard let header else { return }
    if let item = workspaceItem, header.leftItems == [item] { header.leftItems = nil }
    if let filterItem, let right = header.rightItems, right.contains(filterItem) { header.rightItems = nil }
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
    showPadBar(regular)
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

  private func menuItems(_ model: Model) -> [LodyMenuItem] {
    var items = [model.devices.menu]
    items += model.workspaces.map { workspace in
      var item = LodyMenuItem()
      item.id = workspace.id
      item.title = workspace.name
      item.selected = workspace.id == model.selected?.id
      // Each workspace shows its real logo, its initial until that loads (as the capsule).
      item.photo = workspace.image ?? ""
      item.monogram = String(workspace.name.prefix(1)).uppercased()
      return item
    }
    if model.selected != nil {
      var edit = LodyMenuItem()
      edit.id = Self.editId
      edit.title = String(localized: "workspace.edit.action", bundle: .lody)
      items.append(edit)
    }
    return items
  }

  private func selected(_ id: String) {
    if id == Self.editId {
      editWorkspace?()
    } else if !id.hasPrefix("__device") {
      selectWorkspace?(id)
    }
  }

  private func setSearching(_ value: Bool) {
    guard searching != value, let host, let header else { return }
    searching = value
    guard host.traitCollection.horizontalSizeClass != .regular, let workspaceItem else { return }
    header.leftItems = value ? nil : [workspaceItem]
  }

  /// iPhone view menu: toggles for what each chat row's second line shows. Built when the menu
  /// opens (uncached) so the checkmarks always match the stored choice, and a tap closes the menu:
  /// keeping it open never redrew the checkmark (UIKit shows a copy of the actions), so the
  /// setting changed while the check stayed put.
  private func compactViewMenu() -> UIMenu {
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
    return UIMenu(
      children: [
        UIMenu(title: String(localized: "home.view.scope", bundle: .lody), options: [.displayInline, .singleSelection], children: [scopes]),
        UIMenu(title: String(localized: "home.view.grouping", bundle: .lody), options: [.displayInline, .singleSelection], children: [groupings]),
        UIMenu(title: String(localized: "home.view.details", bundle: .lody), options: .displayInline, children: toggles),
      ]
    )
  }

  /// Centre pill, as on the web mobile header: syncing / offline, plus a brief "connected" flash on recovery.
  private func updateSync(_ next: HomeSyncState, compact: Bool) {
    guard let host else { return }
    let previous = syncState
    syncState = next
    if next == .live, previous != .live {
      recoveryTask?.cancel()
      showSync(.recovered, in: host, compact: compact)
      recoveryTask = Task { [weak self] in
        try? await Task.sleep(for: .milliseconds(1200))
        guard let self, !Task.isCancelled, self.syncState == .live, let host = self.host else { return }
        self.showSync(nil, in: host, compact: host.traitCollection.horizontalSizeClass != .regular)
      }
      return
    }
    if next != .live { recoveryTask?.cancel() }
    let shown: HomeSyncPill.Shown? = switch next {
    case .live: syncShown == .recovered ? .recovered : nil
    case .syncing: .syncing
    case .offline: .offline
    }
    showSync(shown, in: host, compact: compact)
  }

  private func showSync(_ shown: HomeSyncPill.Shown?, in host: UIViewController, compact: Bool) {
    syncShown = shown
    syncPill.configuration = UIHostingConfiguration { HomeSyncPill(state: compact ? shown : nil) }.margins(.all, 0)
    syncPill.backgroundColor = .clear
    syncPill.isUserInteractionEnabled = false
    syncPill.accessibilityIdentifier = "home-sync-status"
    let collapsed = compact && shown != nil
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

  private func filterMenu(mode: Int, sort: InboxSort) -> UIMenu {
    let views = Self.views.map { view in
      UIAction(title: String(localized: String.LocalizationValue(view.key), bundle: .lody), image: UIImage(systemName: view.icon), state: mode == view.mode ? .on : .off) {
        [weak self] _ in self?.setView?(view.mode)
      }
    }
    let sorts = Self.sorts.map { item in
      UIAction(
        title: String(localized: String.LocalizationValue("inbox.settings.sort." + item.sort.rawValue), bundle: .lody), image: UIImage(systemName: item.icon),
        state: sort == item.sort ? .on : .off
      ) { [weak self] _ in self?.setSort?(item.sort) }
    }
    return UIMenu(children: views + [UIMenu(options: .displayInline, children: sorts)])
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
