import UIKit
import LodyKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    LodyApplication.shared.launch(application, options: options)
    return true
  }
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                   options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: session.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    self.window = window
    LodyApplication.shared.start(in: window)
    for context in options.urlContexts { LodyApplication.shared.open(context.url) }
  }
  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    for context in contexts { LodyApplication.shared.open(context.url) }
  }
  func sceneDidBecomeActive(_ scene: UIScene) { LodyApplication.shared.active() }
  func sceneDidEnterBackground(_ scene: UIScene) { LodyApplication.shared.background() }
}
