import UIKit

@MainActor
final class LodyAccentLifecycle {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    lodyApplyWindowAccent()
    LodyVerifyWidth.install()
    return true
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    lodyApplyWindowAccent()
    GlassTransitionSpike.openIfRequested()
  }
}
