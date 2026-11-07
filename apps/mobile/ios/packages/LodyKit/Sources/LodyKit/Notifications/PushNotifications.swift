import OneSignalFramework
import UserNotifications
import UIKit

/// Process-owned listener: notification clicks can precede scene restoration.
@MainActor
final class PushNotifications: NSObject, OSNotificationClickListener, OSNotificationLifecycleListener, OSPushSubscriptionObserver {
  static let shared = PushNotifications()
  private(set) var configured = false
  private var userId: String?
  private var clicks = PushClickBuffer()
  var onClickAvailable: (() -> Void)?
  var visibleRoute = ""
  private var registered = false
  #if DEBUG
  private var verificationShown = false
  var onRegistered: (() -> Void)?
  #endif

  func start(_ options: [UIApplication.LaunchOptionsKey: Any]?) {
    if LodyUIVerify.enabled || LodyUIVerify.offline { return }
    guard !configured, let appId = Bundle.main.object(forInfoDictionaryKey: "LodyOneSignalAppId") as? String,
          UUID(uuidString: appId) != nil else { return }
    configured = true
    OneSignal.Debug.setLogLevel(.LL_NONE)
    OneSignal.initialize(appId, withLaunchOptions: options)
    DiagnosticsStore.shared.record("notification", "sdk_initialized", fields: ["configured": "true", "oneSignalApp": appId])
    PushPermissionLaunchRequest.perform {
      OneSignal.Notifications.requestPermission({ accepted in
        DiagnosticsStore.shared.record("notification", "permission_result", fields: ["accepted": String(accepted)])
      }, fallbackToSettings: false)
    }
    OneSignal.User.pushSubscription.addObserver(self)
    evaluateSubscription(OneSignal.User.pushSubscription.id)
    OneSignal.Notifications.addClickListener(self)
    OneSignal.Notifications.addForegroundLifecycleListener(self)
  }

  nonisolated func onPushSubscriptionDidChange(state: OSPushSubscriptionChangedState) {
    let id = state.current.id
    Task { @MainActor in
      self.evaluateSubscription(id)
    }
  }

  private func evaluateSubscription(_ id: String?) {
    registered = PushClickBuffer.isRegistered(id)
    DiagnosticsStore.shared.record("notification", "subscription_observed", fields: ["registered": String(registered)])
    #if DEBUG
    if registered { onRegistered?() }
    #endif
  }

  #if DEBUG
  func verify(from controller: UIViewController) {
    guard configured, registered, !verificationShown, controller.presentedViewController == nil, controller.viewIfLoaded?.window != nil else { return }
    verificationShown = true
    let alert = UIAlertController(title: "Your OneSignal SDK integration is complete!", message: "You can now send Push Notifications & In-App Messages through OneSignal. Tap below to enable push notifications.", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Got it", style: .default) { _ in
      OneSignal.Notifications.requestPermission({ _ in }, fallbackToSettings: false)
    })
    controller.present(alert, animated: true)
  }
  #endif

  func identify(_ id: String?) {
    guard configured else { return }
    let previous = userId ?? OneSignal.User.externalId
    userId = id
    DiagnosticsStore.shared.record("notification", "identity_observed", fields: ["identified": String(id != nil), "current": String(previous == id)])
    clicks.identify(id)
    if let id, !id.isEmpty {
      if let previous, previous != id { clearDelivered() }
      OneSignal.login(id)
      // Never trigger the system permission prompt as a side effect of login.
      if OneSignal.Notifications.permission { OneSignal.User.pushSubscription.optIn() }
    } else {
      visibleRoute = ""
      if previous != nil { OneSignal.logout() }
      OneSignal.User.pushSubscription.optOut()
      clearDelivered()
    }
  }

  func status(_ completion: @escaping @MainActor ([String: any Sendable]) -> Void) {
    Task { @MainActor in
      let settings = await UNUserNotificationCenter.current().notificationSettings()
      let permission: String
      switch settings.authorizationStatus {
      case .notDetermined: permission = "notDetermined"
      case .denied: permission = "denied"
      case .authorized, .provisional, .ephemeral: permission = "authorized"
      @unknown default: permission = "denied"
      }
      if self.configured, self.userId != nil, permission == "authorized" {
        OneSignal.User.pushSubscription.optIn()
      }
      DiagnosticsStore.shared.record("notification", "status", fields: ["configured": String(self.configured), "permission": permission, "registered": String(self.registered)])
      completion(["configured": self.configured, "permission": permission, "registered": self.registered])
    }
  }

  func request(_ completion: @escaping @MainActor (Bool) -> Void) {
    guard configured, let requestedUser = userId else { completion(false); return }
    DiagnosticsStore.shared.record("notification", "permission_requested")
    OneSignal.Notifications.requestPermission({ accepted in
      Task { @MainActor in
        DiagnosticsStore.shared.record("notification", "permission_result", fields: ["accepted": String(accepted), "current": String(self.userId == requestedUser)])
        if accepted, self.userId == requestedUser { OneSignal.User.pushSubscription.optIn() }
        completion(accepted)
      }
    }, fallbackToSettings: false)
  }

  func readPending() -> [String: String]? { clicks.pending }
  func acknowledge(_ id: String) {
    DiagnosticsStore.shared.record("notification", "click_acknowledged", fields: ["message": id, "current": String(clicks.pending?["id"] == id)])
    clicks.acknowledge(id)
  }

  nonisolated func onClick(event: OSNotificationClickEvent) {
    let id = event.notification.notificationId
    let route = event.notification.additionalData?["route"] as? String
    let recipient = event.notification.additionalData?["recipientUserId"] as? String
    Task { @MainActor in
      DiagnosticsStore.shared.record("notification", "click_received", fields: ["message": id ?? "", "appState": String(UIApplication.shared.applicationState.rawValue)])
      guard let id, let route, route.utf8.count <= 2048,
            let owner = recipient ?? self.userId ?? OneSignal.User.externalId, !owner.isEmpty else {
        DiagnosticsStore.shared.record("notification", "click_rejected", fields: ["message": id ?? "", "reason": "invalid_payload"])
        return
      }
      self.clicks.receive(id: id, route: route, userId: owner)
      if self.clicks.pending?["id"] == id {
        DiagnosticsStore.shared.record("notification", "click_buffered", fields: ["message": id])
      } else {
        DiagnosticsStore.shared.record("notification", "click_rejected", fields: ["message": id, "reason": "invalid_payload"])
      }
      self.onClickAvailable?()
    }
  }

  nonisolated func onWillDisplay(event: OSNotificationWillDisplayEvent) {
    event.preventDefault()
    let route = event.notification.additionalData?["route"] as? String
    let recipient = event.notification.additionalData?["recipientUserId"] as? String
    let id = event.notification.notificationId ?? ""
    nonisolated(unsafe) let event = event
    Task { @MainActor in
      DiagnosticsStore.shared.record("notification", "foreground_received", fields: ["message": id])
      let reason: String?
      if self.userId == nil { reason = "signed_out" }
      else if recipient != nil && recipient != self.userId { reason = "wrong_account" }
      else if !self.visibleRoute.isEmpty && route == self.visibleRoute { reason = "visible_session" }
      else { reason = nil }
      if let reason {
        DiagnosticsStore.shared.record("notification", "foreground_suppressed", fields: ["message": id, "reason": reason])
        return
      }
      DiagnosticsStore.shared.record("notification", "foreground_display_requested", fields: ["message": id])
      event.notification.display()
    }
  }

  private func clearDelivered() {
    UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    UNUserNotificationCenter.current().setBadgeCount(0)
  }
}

@MainActor
final class PushLifecycle {
  func applicationDidEnterBackground(_ application: UIApplication) {
    DiagnosticsStore.shared.record("app", "background", fields: ["appState": String(application.applicationState.rawValue)])
    DiagnosticsStore.shared.flush()
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    DiagnosticsStore.shared.record("app", "foreground", fields: ["appState": String(application.applicationState.rawValue)])
    PushNotifications.shared.status { _ in }
  }

  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    DiagnosticsStore.shared.record("app", "launch", fields: ["appState": String(application.applicationState.rawValue), "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""])
    PushNotifications.shared.start(launchOptions)
    return true
  }
}
