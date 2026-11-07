import LodyDesignSystem
import UIKit

/// iPhone Home's top-level destinations. iPad keeps the split view and does not show tabs.
enum HomeTab: CaseIterable, Sendable {
  case chats, projects, settings

  var icon: LodyIcon {
    switch self {
    case .chats: .sessions
    case .projects: .folder
    case .settings: .settings
    }
  }

  var title: String {
    switch self {
    case .chats: String(localized: "home.tab.chats", bundle: .lody)
    case .projects: String(localized: "inbox.section.projects", bundle: .lody)
    case .settings: String(localized: "tabs.settings", bundle: .lody)
    }
  }
}

/// UIKit owns tab layout, minimization and the selected icon throughout each transition.
@MainActor
final class HomeTabsController: UITabBarController, UITabBarControllerDelegate {
  var onSelect: (HomeTab) -> Void = { _ in }
  var onCreate: () -> Void = {}
  var onDebug: () -> Void = {}
  private static let createID = "home-new-session"

  override func viewDidLoad() {
    super.viewDidLoad()
    delegate = self
    mode = .tabBar
    tabBarMinimizeBehavior = .onScrollDown
    tabBar.tintColor = LodyUIColor.accentFg
    tabBar.unselectedItemTintColor = LodyUIColor.iconSecondary
    tabBar.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:))))
  }

  func install(navigation: @escaping (HomeTab) -> UINavigationController) {
    tabs = HomeTab.allCases.map { destination in
      let tab = UITab(title: destination.title, image: destination.icon.uiImage,
        identifier: "home-tab-\(destination)") { _ in navigation(destination) }
      tab.accessibilityIdentifier = tab.identifier
      return tab
    } + [UITab(title: String(localized: "tabs.newSession", bundle: .lody), image: LodyIcon.compose.uiImage,
      identifier: Self.createID) { _ in UIViewController() }]
    tabs.last?.accessibilityIdentifier = Self.createID
    // iOS 27 supports a separate prominent action without misrepresenting it as Search.
    if #available(iOS 27.0, *) { prominentTabIdentifier = Self.createID }
  }

  func show(_ destination: HomeTab) {
    selectedTab = tab(forIdentifier: "home-tab-\(destination)")
    tabBarMinimizeBehavior = destination == .chats ? .onScrollDown : .never
    updateCreate(destination)
  }

  /// On Projects the create action adds a project ("+"); elsewhere it starts a chat.
  private func updateCreate(_ destination: HomeTab) {
    guard let create = tab(forIdentifier: Self.createID) else { return }
    let projects = destination == .projects
    create.image = projects ? LodyIcon.plus.uiImage : LodyIcon.compose.uiImage
    create.title = String(localized: String.LocalizationValue(projects ? "projects.add.title" : "tabs.newSession"), bundle: .lody)
  }

  func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
    if tab.identifier == Self.createID { onCreate(); return false }
    return true
  }

  func tabBarController(_ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?) {
    guard let destination = HomeTab.allCases.first(where: { selectedTab.identifier == "home-tab-\($0)" }) else { return }
    tabBarMinimizeBehavior = destination == .chats ? .onScrollDown : .never
    updateCreate(destination)
    onSelect(destination)
  }

  @objc private func longPressed(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .began, selectedTab?.identifier == "home-tab-settings" else { return }
    onDebug()
  }
}

/// The split view needs a navigation host to push its detail on compact width.
/// The tabs already own navigation bars; hide the outer bar whenever they return.
@MainActor
final class HomeCompactNavigation: UINavigationController, UINavigationControllerDelegate {
  override func viewDidLoad() {
    super.viewDidLoad()
    delegate = self
  }

  func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
    setNavigationBarHidden(viewController is HomeTabsController, animated: animated)
  }
}
