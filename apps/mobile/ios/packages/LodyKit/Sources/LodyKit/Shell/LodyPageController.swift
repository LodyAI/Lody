import UIKit
import ObjectiveC

/// Content that renders navigation chrome inside its own transitioning page.
@MainActor protocol LodyPageOwnedHeader: AnyObject {
  /// False while the content's own navigation should take the edge swipe (a pushed picker).
  var allowsPageSwipeBack: Bool { get }
}

extension LodyPageOwnedHeader {
  var allowsPageSwipeBack: Bool { true }
}

struct ShellPageSpec {
  var title: String
  var style: String
  var animation: String
  var dismissible: Bool
  var headerShown: Bool
  var headerVariant: String
  var detents: [Double]?
  var grabber: Bool?
  var initialDetent: Int?
}

final class LodyPageController: UIViewController {
  let spec: ShellPageSpec
  let inSheet: Bool
  var onResult: ((Any?) -> Void)?
  var onCallback: (@MainActor (String, Any) async throws -> Void)?
  var onClose: (() -> Void)?
  private(set) var closed = false
  var isRehosting = false
  private var headerHidden: Bool?
  private let content: UIViewController
  var ownsHeader: Bool { content is LodyPageOwnedHeader }
  var allowsPageSwipeBack: Bool { (content as? LodyPageOwnedHeader)?.allowsPageSwipeBack ?? true }

  init(spec: ShellPageSpec, inSheet: Bool, content: UIViewController) {
    self.spec = spec
    self.inSheet = inSheet
    self.content = content
    super.init(nibName: nil, bundle: nil)
    title = spec.title
    // Declare the bottom-bar policy before UIKit builds its push animator.
    hidesBottomBarWhenPushed = true
    let appearance = UINavigationBarAppearance()
    appearance.configureWithTransparentBackground()
    if inSheet, spec.headerVariant == "glass" {
      appearance.backgroundEffect = UIBlurEffect(style: .systemChromeMaterial)
    }
    navigationItem.standardAppearance = appearance
    navigationItem.scrollEdgeAppearance = appearance
    navigationItem.compactAppearance = appearance
    navigationItem.backButtonDisplayMode = .minimal
    NotificationCenter.default.addObserver(
      self, selector: #selector(appearanceChanged), name: .lodyAppearanceDidChange, object: nil
    )
  }

  required init?(coder: NSCoder) { nil }

  isolated deinit { NotificationCenter.default.removeObserver(self) }

  override func loadView() {
    view = UIView()
    embed(content)
    addCloseItem()
    updateBackground()
  }

  // Sheet roots without their own items receive a shared close control.
  private func addCloseItem() {
    guard !ownsHeader, inSheet, spec.style != "push", spec.headerShown,
          navigationItem.rightBarButtonItems?.isEmpty ?? true, navigationItem.leftBarButtonItems?.isEmpty ?? true else { return }
    let close = UIBarButtonItem(primaryAction: UIAction(image: UIImage(systemName: "xmark")) { [weak self] _ in
      // An active search controller is presented by this page; dismissing the page itself would only end the search.
      let sheet = self?.navigationController ?? self
      sheet?.presentingViewController?.dismiss(animated: true)
    })
    close.accessibilityLabel = String.localizedStringWithFormat(String(localized: "accessibility.closeSheet", bundle: .lody), String(describing: spec.title))
    navigationItem.rightBarButtonItems = [close]
  }

  private func embed(_ child: UIViewController) {
    addChild(child)
    child.view.frame = view.bounds
    child.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(child.view)
    child.didMove(toParent: self)
    // Native lists bind scroll edges to their own controller; the navigation bar reads this one.
    NotificationCenter.default.addObserver(
      self, selector: #selector(childScrollOwnerChanged), name: LodyScrollEdges.ownerChanged, object: child
    )
  }

  @objc private func childScrollOwnerChanged(_ notification: Notification) {
    guard let child = notification.object as? UIViewController else { return }
    setContentScrollView(child.contentScrollView(for: .top), for: .top)
    setContentScrollView(child.contentScrollView(for: .bottom), for: .bottom)
  }

  override func setToolbarItems(_ toolbarItems: [UIBarButtonItem]?, animated: Bool) {
    hidesBottomBarWhenPushed = toolbarItems?.isEmpty ?? true
    super.setToolbarItems(toolbarItems, animated: animated)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    navigationController?.setNavigationBarHidden(ownsHeader || (headerHidden ?? !spec.headerShown), animated: animated)
    updateBackground()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    var owner = parent
    while let current = owner {
      if let navigation = current as? UINavigationController { PageHeaderPopGestureDelegate.install(on: navigation) }
      owner = current.parent
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isMovingFromParent || (!isRehosting && (isBeingDismissed || navigationController?.isBeingDismissed == true)) {
      markClosed()
    }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (page: LodyPageController, _: UITraitCollection) in
      page.updateBackground()
    }
  }

  func setHeaderHidden(_ value: Bool?) {
    guard value != headerHidden else { return }
    headerHidden = value
    guard let navigationController, navigationController.topViewController === self else { return }
    navigationController.setNavigationBarHidden(ownsHeader || (value ?? !spec.headerShown), animated: false)
  }

  func markClosed() {
    guard !closed else { return }
    closed = true
    let completion = onClose
    onClose = nil; onResult = nil; onCallback = nil
    completion?()
    NotificationCenter.default.post(name: .lodyPageDidClose, object: self)
  }

  @objc private func appearanceChanged() {
    view.backgroundColor = nil
    updateBackground()
  }

  private func updateBackground() {
    guard isViewLoaded else { return }
    let container = navigationController?.modalPresentationStyle
    let regular = (view.window?.traitCollection ?? traitCollection).horizontalSizeClass == .regular
    let overlay = spec.style == "overFullScreen" || container == .overFullScreen
    let compactSheet = inSheet && !regular && (container == .formSheet || container == .pageSheet)
    view.backgroundColor = overlay || compactSheet ? .clear : .lodyGroupedBackground
  }
}

extension Notification.Name {
  static let lodyPageDidClose = Notification.Name("LodyPageDidClose")
}

/// Keep UIKit's recognizers and animator when a page replaces only its navigation chrome.
/// Restore UIKit’s original delegate on every non-conversation page.
@MainActor
final class PageHeaderPopGestureDelegate: NSObject, UIGestureRecognizerDelegate {
  private weak var navigation: UINavigationController?
  private weak var original: UIGestureRecognizerDelegate?
  private nonisolated(unsafe) static var association: UInt8 = 0

  static func install(on navigation: UINavigationController) {
    let top = navigation.topViewController
    let page = (top as? UINavigationController)?.topViewController ?? top
    let pageOwned = (page as? LodyPageController)?.ownsHeader == true && navigation.viewControllers.count > 1
    for gesture in [navigation.interactivePopGestureRecognizer, navigation.interactiveContentPopGestureRecognizer].compactMap({ $0 }) {
      let proxy: PageHeaderPopGestureDelegate
      if let existing = objc_getAssociatedObject(gesture, &association) as? PageHeaderPopGestureDelegate { proxy = existing }
      else {
        proxy = PageHeaderPopGestureDelegate(navigation: navigation, original: gesture.delegate)
        objc_setAssociatedObject(gesture, &association, proxy, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
      }
      gesture.delegate = pageOwned ? proxy : proxy.original
    }
  }

  private init(navigation: UINavigationController, original: UIGestureRecognizerDelegate?) {
    self.navigation = navigation
    self.original = original
    super.init()
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard let navigation else { return false }
    let top = navigation.topViewController
    let page = (top as? UINavigationController)?.topViewController ?? top
    guard let page = page as? LodyPageController, page.ownsHeader else {
      return original?.gestureRecognizerShouldBegin?(gestureRecognizer) ?? true
    }
    guard page.allowsPageSwipeBack, navigation.viewControllers.count > 1, navigation.transitionCoordinator == nil,
          navigation.presentedViewController == nil else { return false }
    // UIKit’s recognizers own directional recognition; their pan values may reset before this callback.
    return true
  }
}
