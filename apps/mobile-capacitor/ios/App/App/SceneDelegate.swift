import Capacitor
import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // UIKit creates the window and LodyBridgeViewController from Main.storyboard.
        // Keep the legacy window reference available to native plugins.
        (UIApplication.shared.delegate as? AppDelegate)?.window = window

        // The scene owns the window; apply the saved style before the bridge/splash loads.
        LodyStartupTheme.apply(LodyStartupTheme.load(), to: window)

        // Capacitor 8.2 has no SceneDelegateProxy. Load its plugin observers before
        // forwarding a cold-start URL; AppPlugin retains the event until JS listens.
        window?.rootViewController?.loadViewIfNeeded()
        forwardOpenURLs(connectionOptions.urlContexts)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        forwardOpenURLs(URLContexts)
    }

    private func forwardOpenURLs(_ contexts: Set<UIOpenURLContext>) {
        for context in contexts {
            var options: [UIApplication.OpenURLOptionsKey: Any] = [
                .openInPlace: context.options.openInPlace
            ]
            if let sourceApplication = context.options.sourceApplication {
                options[.sourceApplication] = sourceApplication
            }
            if let annotation = context.options.annotation {
                options[.annotation] = annotation
            }
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared, open: context.url, options: options
            )
        }
    }
}
