import UIKit

/// Supplies the source item before the shell asks UIKit to present the sheet.
/// UIKit owns the animation, backdrop and interactive dismissal; the shell keeps
/// its presentation delegate so a swipe still settles the presentation session.
@MainActor
enum LodySheetZoom {
  private static var token: NSObjectProtocol?
  private static var timeout: DispatchWorkItem?
  private static weak var presented: UIViewController?

  static func prepare(sourceLabel: String) {
    disarm()
    token = NotificationCenter.default.addObserver(
      forName: Notification.Name("LodyWillPresent"), object: nil, queue: nil
    ) { notification in
      nonisolated(unsafe) let object = notification.object
      nonisolated(unsafe) let presenter = notification.userInfo?["presenter"]
      MainActor.assumeIsolated {
        guard let destination = object as? UIViewController,
          destination.modalPresentationStyle == .formSheet,
          let presenter = presenter as? UIViewController
        else { return }
        disarm()
        // Resolve from this presentation's window, never another active scene.
        guard let root = presenter.view.window?.rootViewController,
          findSource(label: sourceLabel, from: root) != nil
        else { return }
        destination.preferredTransition = .zoom(sourceBarButtonItemProvider: { [weak presenter] _ in
          // Sending opens a conversation underneath the sheet. Once the source
          // screen is gone, let UIKit handle a missing return target.
          guard let root = presenter?.viewIfLoaded?.window?.rootViewController,
            let current = findSource(label: sourceLabel, from: root)
          else { return nil }
          return current
        })
        presented = destination
      }
    }
    let timeout = DispatchWorkItem { disarm() }
    self.timeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: timeout)
  }

  private static func disarm() {
    timeout?.cancel()
    timeout = nil
    if let token { NotificationCenter.default.removeObserver(token) }
    token = nil
  }

  static func dismiss(completion: @escaping () -> Void) {
    guard let controller = presented, controller.presentingViewController != nil else {
      return completion()
    }
    presented = nil
    controller.dismiss(animated: true, completion: completion)
  }

  private static func findSource(label: String, from controller: UIViewController) -> UIBarButtonItem? {
    // Only visible navigation pages can supply a return target.
    if let navigation = controller as? UINavigationController {
      return navigation.topViewController.flatMap { findSource(label: label, from: $0) }
    }
    if let tabs = controller as? UITabBarController {
      return tabs.selectedViewController.flatMap { findSource(label: label, from: $0) }
    }
    let items = (controller.toolbarItems ?? [])
      + (controller.navigationItem.leftBarButtonItems ?? [])
      + (controller.navigationItem.rightBarButtonItems ?? [])
    if let item = items.first(where: { $0.accessibilityLabel == label }) { return item }
    for child in controller.children {
      if let item = findSource(label: label, from: child) { return item }
    }
    return nil
  }
}
