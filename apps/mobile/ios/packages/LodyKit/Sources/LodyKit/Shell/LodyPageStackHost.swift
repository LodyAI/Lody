import UIKit

/// Hosts a page pushed from a Home tab onto the outer Home stack, whose bar is hidden over the
/// tab controller. UIKit animates a bar that appears or disappears with the transition apart from
/// the page, so on an edge swipe back its Back button and title drifted away from the content.
/// The page instead keeps its own navigation bar inside the transitioning view, as the
/// new-session form does, and later pages push onto that inner stack.
@MainActor
final class LodyPageStackHost: UIViewController, LodyPageOwnedHeader {
  let navigation: UINavigationController

  init(root: LodyPageController) {
    navigation = UINavigationController(rootViewController: root)
    super.init(nibName: nil, bundle: nil)
    LodyShell.shared.configureNavigation(navigation)
    navigation.view.backgroundColor = .clear
    let back = UIBarButtonItem(image: UIImage(systemName: "chevron.backward"), primaryAction: UIAction { [weak self] _ in
      guard let self else { return }
      LodyShell.shared.close(from: self)
    })
    back.accessibilityLabel = String(localized: "common.back", bundle: .lody)
    root.navigationItem.leftBarButtonItem = back
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var childForStatusBarStyle: UIViewController? { navigation }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    addChild(navigation)
    navigation.view.frame = view.bounds
    navigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(navigation.view)
    navigation.didMove(toParent: self)
  }

  /// A page pushed inside the host takes the edge swipe back to the page beneath it first.
  var allowsPageSwipeBack: Bool { navigation.viewControllers.count <= 1 }

  /// The inner pages never leave their own stack, so they close with the host.
  func closePages() {
    navigation.viewControllers.compactMap { $0 as? LodyPageController }.forEach { $0.markClosed() }
  }
}
