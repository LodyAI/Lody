import GoogleSignIn
import LodyCore
import LodyDesignSystem
import UIKit

/// One scene owns the runtime and the application coordinators, independently of page lifetimes.
@MainActor
public final class LodyApplication {
  public static let shared = LodyApplication()
  private let accent = LodyAccentLifecycle()
  private let push = PushLifecycle()

  public func launch(_ application: UIApplication, options: [UIApplication.LaunchOptionsKey: Any]?) {
    // Inter / JetBrains Mono for design-system surfaces (the Home chat list).
    LodyFonts.register()
    _ = accent.application(application, didFinishLaunchingWithOptions: options)
    _ = push.application(application, didFinishLaunchingWithOptions: options)
  }
  public func active() { accent.applicationDidBecomeActive(.shared); push.applicationDidBecomeActive(.shared); shares.wake() }
  public func background() { push.applicationDidEnterBackground(.shared) }

  private let runtime = DataRuntime(localStore: .shared)
  private var observers: [NSObjectProtocol] = []
  private var onboarding: LodyPageController?
  private var link: (route: String, user: String?)?
  private var identified: String?
  private var hasIdentified = false
  private let shares = NativeShareCoordinator()
  private var offeredCommunity = false

  public func start(in window: UIWindow) {
    precondition(observers.isEmpty, "Lody supports one active scene")
    ContentPreview.clearAll()
    if LodyUIVerify.offline { URLProtocol.registerClass(OfflineProbe.self) }
    lodyApplyWindowAccent()
    DataRuntime.current = runtime
    AuthSession.shared.presenter = { LodyShell.shared.presenter }
    AuthSession.shared.stopRuntime = { [weak self] in self?.runtime.stop() }
    OutboxSession.shared.presenter = { LodyShell.shared.presenter }
    OutboxSession.shared.attach(runtime)
    CatalogSession.shared.attach(runtime)
    for name in [Notification.Name.lodyAuthDidChange, .lodyCatalogDidChange, UIApplication.didBecomeActiveNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.reconcile() }
      })
    }
    PushNotifications.shared.onClickAvailable = { [weak self] in self?.reconcile() }
    if LodyUIVerify.enabled {
      NativeDebug.start(in: window)
    } else {
      LodyShell.shared.start(in: window, content: HomeController())
      AuthSession.shared.start()
    }
  }

  public func open(_ url: URL) {
    if GIDSignIn.sharedInstance.handle(url) { return }
    guard let destination = AppLink.parse(url.absoluteString) else { return }
    switch destination {
    case .share: shares.wake()
    case .session:
      // Keep the original encoded route; the routing policy validates it again against the account.
      let tail = String(url.absoluteString.dropFirst(7)).prefix { $0 != "?" && $0 != "#" }
      link = (tail.hasPrefix("/") ? String(tail) : "/" + tail, AuthSession.shared.snapshot.account?.user.id)
      if NativeHomeFixture.active { routeNotification() }
      else { reconcile() }
    case .page(let id, let params):
      if id == "debug" { NativeDebug.open(params); return }
      var fields: [String: Any] = params
      if id == "activity" {
        let state = SessionSource.live.state
        fields["userId"] = state.userId; fields["workspaceId"] = state.workspaceId
      }
      let json = SessionController.json(fields)
      LodyShell.shared.openPage(id, params: json, from: nil)
    }
  }

  private func reconcile() {
    guard !LodyUIVerify.enabled else { return }
    let auth = AuthSession.shared.snapshot
    guard auth.localReady, !auth.busy else { return }
    let user = auth.account?.user.id
    if !hasIdentified || identified != user {
      hasIdentified = true
      identified = user
      PushNotifications.shared.identify(user)
    }
    if auth.account == nil {
      shares.stop()
      guard onboarding == nil else { return }
      let regular = HomeController.current?.traitCollection.horizontalSizeClass == .regular
      let page = LodyShell.shared.presentNative(OnboardingController(), title: "", dismissible: false,
        style: regular ? "formSheet" : "pageSheet", headerShown: false)
      onboarding = page
      page.onClose = { [weak self] in self?.onboarding = nil; self?.reconcile() }
      return
    }
    routeNotification()
    shares.reconcile()
    if onboarding == nil { offerCommunityNotice() }
  }

  private func offerCommunityNotice() {
    guard !offeredCommunity else { return }
    offeredCommunity = true
    Task {
      do {
        let seen = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
          LocalStore.queue.async {
            do {
              let seen = try LocalStore.shared.read("communityNoticeSeen") == "true"
              if !seen { try LocalStore.shared.write("communityNoticeSeen", "true") }
              continuation.resume(returning: seen)
            } catch { continuation.resume(throwing: error) }
          }
        }
        guard !seen else { return }
        let alert = UIAlertController(title: String(localized: "communityNotice.title", bundle: .lody),
          message: String(localized: "communityNotice.message", bundle: .lody), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "communityNotice.later", bundle: .lody), style: .cancel))
        alert.addAction(UIAlertAction(title: String(localized: "communityNotice.star", bundle: .lody), style: .default) { _ in
          UIApplication.shared.open(URL(string: "https://github.com/Innei/lody-ios")!)
        })
        LodyShell.shared.presenter?.present(alert, animated: true)
      } catch {
        DiagnosticsStore.shared.record("app", "community_notice_failed", fields: ["error": error.localizedDescription])
      }
    }
  }

  private func routeNotification() {
    let pending = PushNotifications.shared.readPending()
    guard let route = link?.route ?? pending?["route"] else { return }
    let recipient = link == nil ? pending?["userId"] : link?.user
    let state = SessionSource.live.state
    let auth = AuthSession.shared.snapshot
    let context = NativeHomeFixture.active ? NativeHomeFixture.routingContext() : NotificationNavigation.Context(ready: auth.localReady && !auth.busy,
      userId: auth.account?.user.id ?? "", workspaces: auth.account?.workspaces.map { ($0.id, $0.slug) } ?? [],
      selectedId: state.workspaceId, loading: state.loading, connected: state.connected,
      sessionIds: Set(state.catalog.sessions.map(\.id)))
    switch NotificationNavigation.resolve(route: route, recipient: recipient, context: context) {
    case .wait: return
    case .workspace(let id):
      if NativeHomeFixture.active {
        try! NativeHomeFixture.apply("selectWorkspace", ["workspaceId": id])
        routeNotification()
      } else { CatalogSession.shared.selectWorkspace(id) }
      return
    case .session(let id):
      DiagnosticsStore.shared.record("notification", "navigation_opened", fields: [:])
      LodyShell.shared.openSessionFromExternal(id)
    case .discard(let failure):
      DiagnosticsStore.shared.record("notification", "navigation_rejected", fields: ["reason": failure.rawValue])
      let keys: [NotificationNavigation.Failure: String] = [.wrongAccount: "wrongAccount", .unknownRoute: "unknown", .noWorkspace: "noWorkspace", .sessionMissing: "gone"]
      LodyToastOverlay.shared.show(message: String(localized: String.LocalizationValue("notifications.route." + keys[failure]!), bundle: .lody), kind: "error")
    }
    if link != nil { link = nil }
    else if let id = pending?["id"] { PushNotifications.shared.acknowledge(id) }
  }
}
