import UIKit

@MainActor
final class SettingsActor {
  private struct Watcher {
    weak var owner: AnyObject?
    let handler: @MainActor () -> Void
  }

  private(set) var userId: String
  private(set) var workspaceId: String
  private var nativeKey = ""
  private var watchers: [Watcher] = []
  private var observer: NSObjectProtocol?

  var key: String { "\(userId):\(workspaceId)" }
  var valid: Bool { !userId.isEmpty && !workspaceId.isEmpty }

  init(userId: String, workspaceId: String) {
    self.userId = userId
    self.workspaceId = workspaceId
  }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  // The opener passes the actor it showed (Settings fixtures substitute one), so the
  // page follows the native catalog only once its own account or workspace changes.
  static func live(_ params: [String: Any]) -> SettingsActor {
    let current = SettingsWorkspace.current
    let user = (params["userId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? current.userId
    let workspace = (params["workspaceId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? current.workspaceId
    let scope = SettingsActor(userId: user, workspaceId: workspace)
    scope.nativeKey = current.key
    scope.observer = NotificationCenter.default.addObserver(forName: .lodyCatalogDidChange, object: nil, queue: .main) { [weak scope] _ in
      MainActor.assumeIsolated { scope?.catalogChanged() }
    }
    return scope
  }

  private func catalogChanged() {
    let current = SettingsWorkspace.current
    guard current.key != nativeKey else { return }
    nativeKey = current.key
    switchTo(userId: current.userId, workspaceId: current.workspaceId)
  }

  func switchTo(userId: String, workspaceId: String) {
    self.userId = userId
    self.workspaceId = workspaceId
    watchers.removeAll { $0.owner == nil }
    for watcher in watchers where watcher.owner != nil { watcher.handler() }
  }

  func watch(_ owner: AnyObject, _ handler: @escaping @MainActor () -> Void) {
    watchers.append(Watcher(owner: owner, handler: handler))
  }
}

struct SettingsError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

@MainActor
enum SettingsPage {
  static func host(_ list: LodyGroupedList, in controller: UIViewController, event: @escaping (String, [String: Any]) -> Void) {
    list.frame = controller.view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = event
    controller.view.addSubview(list)
  }

  static func apply(_ state: LodyListState, to list: LodyGroupedList) {
    list.setLoading(state.loading)
    list.setNotice(state.notice)
    list.setUnavailable(state.unavailable)
  }

  static func confirm(
    from controller: UIViewController, title: String, message: String, action: String, destructive: Bool,
    perform: @escaping @MainActor () -> Void
  ) {
    let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: String(localized: "common.cancel", bundle: .lody), style: .cancel))
    alert.addAction(UIAlertAction(title: action, style: destructive ? .destructive : .default) { _ in
      MainActor.assumeIsolated { perform() }
    })
    controller.present(alert, animated: true)
  }

  static func pop(_ controller: UIViewController) {
    let page = controller.parent ?? controller
    guard let navigation = page.navigationController, let index = navigation.viewControllers.firstIndex(of: page),
          index > 0 else { return }
    navigation.popToViewController(navigation.viewControllers[index - 1], animated: true)
  }

  static func leaving(_ controller: UIViewController) -> Bool {
    let page = controller.parent ?? controller
    return page.isMovingFromParent || page.isBeingDismissed || page.navigationController?.isBeingDismissed == true
  }
}
