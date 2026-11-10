import OneSignalFramework
import UserNotifications
import UIKit

/// Process-owned listener: notification clicks can precede scene restoration.
@MainActor
final class PushNotifications: NSObject, OSNotificationClickListener, OSNotificationLifecycleListener, OSPushSubscriptionObserver, UNUserNotificationCenterDelegate {
  static let shared = PushNotifications()
  private(set) var configured = false
  private var userId: String?
  private var clicks = PushClickBuffer()
  var onClickAvailable: (() -> Void)?
  var visibleRoute = ""
  private var registered = false
  private var sdkStarted = false
  private var sdkDelegate: (any UNUserNotificationCenterDelegate)?
  private var selectedProvider: PushRegistration.Provider?
  private var identityEpoch = 0
  private var launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  private static var installation: String {
    let key = "lody.push.installation.v1"
    if let saved = UserDefaults.standard.string(forKey: key), UUID(uuidString: saved) != nil { return saved }
    let id = UUID().uuidString
    UserDefaults.standard.set(id, forKey: key)
    return id
  }
  private lazy var registration: PushRegistration = PushRegistration(installation: Self.installation, call: { session, kind, path, args in
    // Capture the credential once: never borrow a newly logged-in account's JWT.
    let auth = try await GitHubCloud.request("https://backend.lody.ai/api/auth/convex/token", token: session.credential) as? [String: Any]
    guard let jwt = auth?["token"] as? String, !jwt.isEmpty else { throw GitHubCloud.failure() }
    let result = try await GitHubCloud.request("https://convex.lody.ai/api/\(kind)", token: jwt,
      body: ["path": path, "format": "convex_encoded_json", "args": [args]]) as? [String: Any]
    guard result?["status"] as? String == "success", let value = result?["value"] else { throw GitHubCloud.failure() }
    return try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
  }, changed: { [weak self] provider, registered in
    guard let self else { return }
    let previous = self.selectedProvider
    self.selectedProvider = provider
    self.configured = provider != nil
    self.registered = registered
    if provider == .oneSignal {
      self.startSDK()
      self.configured = self.sdkStarted
      if let delegate = self.sdkDelegate { UNUserNotificationCenter.current().delegate = delegate }
      if self.sdkStarted, let user = self.userId {
        OneSignal.login(user)
        if self.registration.authorized { OneSignal.User.pushSubscription.optIn() }
        else { OneSignal.User.pushSubscription.optOut() }
        self.evaluateSubscription(OneSignal.User.pushSubscription.id)
      }
    } else {
      if self.sdkStarted {
        OneSignal.User.pushSubscription.optOut()
        OneSignal.logout()
      }
      UNUserNotificationCenter.current().delegate = self
      if provider == .apns, self.registration.authorized,
         previous != .apns || !self.registration.hasDeviceToken || !UIApplication.shared.isRegisteredForRemoteNotifications {
        UIApplication.shared.registerForRemoteNotifications()
      }
    }
  }, failure: {
    DiagnosticsStore.shared.record("notification", "registration_unconfirmed")
  })
  #if DEBUG
  private var verificationShown = false
  var onRegistered: (() -> Void)?
  #endif

  func start(_ options: [UIApplication.LaunchOptionsKey: Any]?) {
    if LodyUIVerify.enabled || LodyUIVerify.offline { return }
    launchOptions = options
    UNUserNotificationCenter.current().delegate = self
    PushPermissionLaunchRequest.perform {
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
        Task { @MainActor in self.refresh() }
      }
    }
  }

  private func startSDK() {
    guard !sdkStarted, let appId = Bundle.main.object(forInfoDictionaryKey: "LodyOneSignalAppId") as? String,
          UUID(uuidString: appId) != nil else { return }
    sdkStarted = true
    OneSignal.Debug.setLogLevel(.LL_NONE)
    OneSignal.initialize(appId, withLaunchOptions: launchOptions)
    OneSignal.User.pushSubscription.addObserver(self)
    evaluateSubscription(OneSignal.User.pushSubscription.id)
    OneSignal.Notifications.addClickListener(self)
    OneSignal.Notifications.addForegroundLifecycleListener(self)
    sdkDelegate = UNUserNotificationCenter.current().delegate
  }

  nonisolated func onPushSubscriptionDidChange(state: OSPushSubscriptionChangedState) {
    let id = state.current.id
    Task { @MainActor in
      self.evaluateSubscription(id)
    }
  }

  private func evaluateSubscription(_ id: String?) {
    guard registration.provider == .oneSignal else { return }
    registered = PushClickBuffer.isRegistered(id)
    DiagnosticsStore.shared.record("notification", "subscription_observed", fields: ["registered": String(registered)])
    #if DEBUG
    if registered { onRegistered?() }
    #endif
  }

  #if DEBUG
  func verify(from controller: UIViewController) {
    guard registration.provider == .oneSignal, configured, registered, !verificationShown, controller.presentedViewController == nil, controller.viewIfLoaded?.window != nil else { return }
    verificationShown = true
    let alert = UIAlertController(title: "Your OneSignal SDK integration is complete!", message: "You can now send Push Notifications & In-App Messages through OneSignal. Tap below to enable push notifications.", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Got it", style: .default) { _ in
      OneSignal.Notifications.requestPermission({ _ in }, fallbackToSettings: false)
    })
    controller.present(alert, animated: true)
  }
  #endif

  func identify(_ id: String?, credential: String? = nil) {
    guard !LodyUIVerify.enabled, !LodyUIVerify.offline else { return }
    if userId != id || registration.session?.credential != credential {
      identityEpoch += 1
      clearDelivered()
      visibleRoute = ""
    }
    userId = id
    clicks.identify(id)
    let changed = registration.session?.user != id || registration.session?.credential != credential
    registration.identify(user: id, credential: credential)
    if changed { refresh() }
  }

  func refresh() {
    let epoch = identityEpoch
    Task { @MainActor in
      let settings = await UNUserNotificationCenter.current().notificationSettings()
      guard epoch == self.identityEpoch else { return }
      self.registration.refresh(authorized: [UNAuthorizationStatus.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus))
    }
  }

  func deviceToken(_ data: Data) {
    registration.deviceToken(data.map { String(format: "%02x", $0) }.joined(), bundle: Bundle.main.bundleIdentifier)
    refresh()
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
      self.refresh()
      DiagnosticsStore.shared.record("notification", "status", fields: ["configured": String(self.configured), "permission": permission, "registered": String(self.registered)])
      completion(["configured": self.configured, "permission": permission, "registered": self.registered])
    }
  }

  func request(_ completion: @escaping @MainActor (Bool) -> Void) {
    guard userId != nil else { completion(false); return }
    let epoch = identityEpoch
    Task { @MainActor in
      let accepted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
      guard epoch == self.identityEpoch else { completion(false); return }
      self.refresh()
      completion(accepted)
    }
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    let recipient = notification.request.content.userInfo["recipientUserId"] as? String
    let route = notification.request.content.userInfo["route"] as? String
    return await MainActor.run {
      guard self.registration.provider == .apns,
            PushClickBuffer.shouldDisplay(userId: self.userId, recipient: recipient,
              route: route, visibleRoute: self.visibleRoute) else { return [] }
      return [.banner, .list, .sound, .badge]
    }
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
    let data = response.notification.request.content.userInfo
    guard let payload = PushClickBuffer.payload(data) else { return }
    let id = (data["custom"] as? [String: Any])?["i"] as? String ?? response.notification.request.identifier
    await MainActor.run {
      self.clicks.receive(id: id, route: payload.route, userId: payload.recipient)
      self.onClickAvailable?()
    }
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
            let owner = recipient, !owner.isEmpty else {
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
      guard self.registration.provider == .oneSignal,
            PushClickBuffer.shouldDisplay(userId: self.userId, recipient: recipient, route: route, visibleRoute: self.visibleRoute) else {
        DiagnosticsStore.shared.record("notification", "foreground_suppressed", fields: ["message": id])
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
