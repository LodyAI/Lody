import UIKit

@MainActor
final class LodyShell {
  static let shared = LodyShell()

  private var navigation: UINavigationController?
  private let delegate = ShellNavigationDelegate()

  var presenter: UIViewController? { topController() }

  func start(in window: UIWindow, content: UIViewController, title: String = "") {
    let spec = ShellPageSpec(title: title, style: "push", animation: "none", dismissible: false,
      headerShown: !title.isEmpty, headerVariant: "transparent")
    let root = LodyPageController(spec: spec, inSheet: false, content: content)
    let navigation = UINavigationController(rootViewController: root)
    configureNavigation(navigation)
    self.navigation = navigation
    window.rootViewController = navigation
    window.makeKeyAndVisible()
  }

  func pushNative(_ id: String, title: String, params: [String: Any] = [:], from source: UIViewController) {
    let json = (try? JSONSerialization.data(withJSONObject: params)).map { String(decoding: $0, as: UTF8.self) }
    guard let content = LodyNativePages.make(id, params: json) else { return }
    pushNative(content, title: title, from: source)
  }

  @discardableResult
  func pushNative(_ content: UIViewController, title: String, from source: UIViewController, headerShown: Bool = true) -> LodyPageController? {
    guard let base = (source as? UINavigationController) ?? source.navigationController else { return nil }
    let target = HomeController.current?.pushTarget(for: base) ?? base
    let spec = ShellPageSpec(
      title: title, style: "push", animation: "slide", dismissible: true, headerShown: headerShown,
      headerVariant: "transparent"
    )
    let page = LodyPageController(spec: spec, inSheet: target !== navigation, content: content)
    if target !== base {
      // Leaving a tab for the outer Home stack: the page carries its own bar (`LodyPageStackHost`).
      let host = LodyPageController(spec: spec, inSheet: target !== navigation, content: LodyPageStackHost(root: page))
      push(host, on: target)
    } else {
      push(page, on: target)
    }
    return page
  }

  @discardableResult
  func presentNative(_ content: UIViewController, title: String, detents: [Double] = [1], grabber: Bool = false, dismissible: Bool = true, style: String = "formSheet", headerShown: Bool = true, size: CGSize? = nil) -> LodyPageController {
    let spec = ShellPageSpec(
      title: title, style: style, animation: "slide", dismissible: dismissible, headerShown: headerShown,
      headerVariant: "transparent", detents: detents, grabber: grabber
    )
    let page = LodyPageController(spec: spec, inSheet: true, content: content)
    // A regular-width form sheet takes this size (UIKit ignores it where sheets fill the width).
    if let size { page.preferredContentSize = size }
    presentModal(page)
    return page
  }

  func openPage(_ id: String, params: String = "{}", options: [String: Any] = [:], from source: UIViewController?) {
    guard let content = LodyNativePages.make(id, params: params) else {
      preconditionFailure("Unknown native page: \(id)")
    }
    if options["present"] as? Bool == true {
      presentNative(content, title: content.title ?? "", grabber: true)
    } else if let source {
      pushNative(content, title: content.title ?? "", from: source)
    } else { pushRootNative(content, title: content.title ?? "") }
  }

  func configureNavigation(_ controller: UINavigationController) {
    controller.delegate = delegate
    PageHeaderPopGestureDelegate.install(on: controller)
  }

  @discardableResult
  func pushRootNative(_ content: UIViewController, title: String, headerShown: Bool = true) -> LodyPageController? {
    guard let navigation else { return nil }
    return pushNative(content, title: title, from: navigation, headerShown: headerShown)
  }

  func presentDetail(_ content: UIViewController, title: String, from source: UIViewController, push: Bool = false, detents: [Double] = [0.6, 1], onClose: (() -> Void)? = nil) {
    if HomeController.current?.showPanel(content, title: title, from: source, push: push, detents: detents, onClose: onClose) == true { return }
    if push {
      guard let page = pushNative(content, title: title, from: source) else { onClose?(); return }
      page.onClose = onClose
    } else {
      guard presenter != nil else { onClose?(); return }
      presentNative(content, title: title, detents: detents, grabber: true).onClose = onClose
    }
  }

  @discardableResult
  func presentNavigation(_ container: UINavigationController, detents: [Double] = [1], popoverFrom item: UIBarButtonItem? = nil,
    sourceView: UIView? = nil, sourceRect: CGRect? = nil) -> UIViewController? {
    guard let navigation, navigation.presentedViewController == nil else { return nil }
    let modal: UIViewController
    let isPopover = item != nil || sourceView != nil
    if !isPopover { modal = ShellNavigationHost(container) }
    else { modal = container }
    modal.modalPresentationStyle = isPopover ? .popover : .formSheet
    if isPopover, let popover = modal.popoverPresentationController {
      container.preferredContentSize = CGSize(width: 320, height: 600)
      if let sourceView {
        popover.barButtonItem = nil
        popover.sourceView = sourceView
        popover.sourceRect = sourceRect ?? sourceView.bounds
      } else {
        popover.sourceView = nil
        popover.sourceRect = .zero
        popover.barButtonItem = item
      }
      popover.permittedArrowDirections = .up
    } else if let sheet = modal.sheetPresentationController {
      Self.configure(sheet, ShellPageSpec(title: "", style: "formSheet", animation: "slide", dismissible: true,
        headerShown: true, headerVariant: "transparent", detents: detents, grabber: true))
    }
    NotificationCenter.default.post(name: Notification.Name("LodyWillPresent"), object: modal, userInfo: ["presenter": navigation])
    navigation.present(modal, animated: true)
    return modal
  }

  func releaseNavigation(from modal: UIViewController) {
    (modal as? ShellNavigationHost)?.releaseNavigation()
  }

  func sessionIntent(_ action: String, _ fields: [String: Any]) {
    do { try SessionNavigation.handle(action, fields) }
    catch { LodyToastOverlay.shared.show(message: String(localized: "session.toast.openFailed", bundle: .lody), kind: .error) }
  }

  func finish(from controller: UIViewController?, value: Any?) {
    Self.page(of: controller)?.onResult?(value)
  }

  func callback(from controller: UIViewController?, name: String, value: Any) async throws {
    guard let callback = Self.page(of: controller)?.onCallback else {
      throw NSError(domain: "Lody.Navigation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing native callback: \(name)"])
    }
    try await callback(name, value)
  }

  /// `crossfade` replaces a pushed page with the one beneath it by a short fade instead of the
  /// sliding back transition, for pages that hand over to the destination rather than return.
  func close(from controller: UIViewController?, crossfade: Bool = false) {
    guard let page = Self.page(of: controller) else { return }
    if HomeController.current?.closePanel(from: page) == true { return }
    guard let navigation = page.navigationController else { return }
    if navigation.viewControllers.first === page, let host = navigation.parent as? LodyPageStackHost {
      close(from: host, crossfade: crossfade)
    } else if navigation.viewControllers.first === page { navigation.presentingViewController?.dismiss(animated: true) }
    else if crossfade {
      let fade = CATransition()
      fade.type = .fade
      fade.duration = 0.2
      fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
      navigation.view.layer.add(fade, forKey: kCATransition)
      navigation.popViewController(animated: false)
    }
    else { navigation.popViewController(animated: true) }
  }

  private static func page(of controller: UIViewController?) -> LodyPageController? {
    var current = controller
    while let candidate = current, !(candidate is LodyPageController) { current = candidate.parent }
    return current as? LodyPageController
  }

  private func push(_ page: LodyPageController, on target: UINavigationController?) {
    guard let target else { return }
    if let transition = target.transitionCoordinator {
      transition.animate(alongsideTransition: nil) { [weak self, weak target] _ in
        guard !page.closed else { return }
        self?.push(page, on: target)
      }
      return
    }
    NotificationCenter.default.post(name: Notification.Name("LodyWillPush"), object: page)
    target.pushViewController(page, animated: page.spec.animation != "none")
  }

  func openSessionFromExternal(_ id: String) {
    guard let navigation else { preconditionFailure("Application navigation has not started") }
    let open = {
      HomeController.current?.reset()
      navigation.popToRootViewController(animated: false)
      HomeController.current?.openSession(id)
    }
    if navigation.presentedViewController != nil { navigation.dismiss(animated: true, completion: open) }
    else { open() }
  }

  func popToRoot() {
    guard let navigation else { return }
    if navigation.presentedViewController != nil {
      navigation.dismiss(animated: true)
    }
    HomeController.current?.reset()
    navigation.popToRootViewController(animated: true)
  }

  private func presentModal(_ page: LodyPageController) {
    let top = topController()
    let settling = top?.presentedViewController ?? (top?.isBeingPresented == true ? top : nil)
    if let transition = settling?.transitionCoordinator {
      transition.animate(alongsideTransition: nil) { [weak self] _ in
        guard !page.closed else { return }
        self?.presentModal(page)
      }
      return
    }
    guard let presenter = top else { return }
    let spec = page.spec
    let container = UINavigationController(rootViewController: page)
    configureNavigation(container)
    container.setNavigationBarHidden(!spec.headerShown, animated: false)
    container.modalPresentationStyle = Self.modalStyle(spec.style)
    if page.preferredContentSize != .zero { container.preferredContentSize = page.preferredContentSize }
    if spec.style == "overFullScreen" { container.view.backgroundColor = .clear }
    if spec.animation == "fade" { container.modalTransitionStyle = .crossDissolve }
    container.isModalInPresentation = !spec.dismissible
    if let sheet = container.sheetPresentationController, spec.style == "formSheet" || spec.style == "pageSheet" {
      Self.configure(sheet, spec)
    }
    NotificationCenter.default.post(
      name: Notification.Name("LodyWillPresent"), object: container, userInfo: ["presenter": presenter]
    )
    presenter.present(container, animated: spec.animation != "none")
  }

  private func topController() -> UIViewController? {
    var top: UIViewController? = navigation
    while let presented = top?.presentedViewController, !presented.isBeingDismissed { top = presented }
    return top
  }

  private static func modalStyle(_ style: String) -> UIModalPresentationStyle {
    switch style {
    case "fullScreen": .fullScreen
    case "overFullScreen": .overFullScreen
    case "formSheet": .formSheet
    default: .pageSheet
    }
  }

  private static func configure(_ sheet: UISheetPresentationController, _ spec: ShellPageSpec) {
    sheet.prefersGrabberVisible = spec.grabber ?? false
    guard let fractions = spec.detents, !fractions.isEmpty else { return }
    let detents = fractions.map { fraction -> UISheetPresentationController.Detent in
      if fraction >= 1 { return .large() }
      return .custom(identifier: .init("fraction-\(fraction)")) { $0.maximumDetentValue * fraction }
    }
    sheet.detents = detents
    if let index = spec.initialDetent {
      let resolved = index < 0 ? detents.count - 1 : min(index, detents.count - 1)
      sheet.selectedDetentIdentifier = detents[resolved].identifier
    }
  }
}

private final class ShellNavigationDelegate: NSObject, UINavigationControllerDelegate {
  func navigationController(
    _ navigationController: UINavigationController,
    didShow viewController: UIViewController,
    animated: Bool
  ) {
    // Reconcile only after UIKit settles, including a cancelled interactive pop.
    navigationController.setToolbarHidden(viewController.toolbarItems?.isEmpty ?? true, animated: false)
  }
}


extension UIView {
  var owningViewController: UIViewController? {
    var responder = next
    while let current = responder {
      if let controller = current as? UIViewController { return controller }
      responder = current.next
    }
    return nil
  }
}

// Keep UIKit's modal decorations on a disposable host. The reusable navigation
// stack remains a child controller when it moves between a split and a Sheet.
private final class ShellNavigationHost: UIViewController {
  private let navigation: UINavigationController
  init(_ navigation: UINavigationController) {
    self.navigation = navigation
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var childForStatusBarStyle: UIViewController? { navigation }
  override func viewDidLoad() {
    super.viewDidLoad()
    addChild(navigation)
    navigation.view.frame = view.bounds
    navigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(navigation.view)
    navigation.didMove(toParent: self)
  }
  func releaseNavigation() {
    navigation.willMove(toParent: nil)
    navigation.view.removeFromSuperview()
    navigation.removeFromParent()
  }
}
