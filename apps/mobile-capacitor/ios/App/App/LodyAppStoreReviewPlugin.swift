import Capacitor
import StoreKit
import UIKit

@objc(LodyAppStoreReviewPlugin)
public final class LodyAppStoreReviewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LodyAppStoreReviewPlugin"
    public let jsName = "LodyAppStoreReview"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestReview", returnType: CAPPluginReturnPromise),
    ]

    @objc public func requestReview(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self, let scene = self.activeWindowScene() else {
                call.resolve(["requested": false])
                return
            }

            AppStore.requestReview(in: scene)
            // StoreKit intentionally does not report whether it displayed the sheet or what
            // rating the person selected. This only confirms that the request was forwarded.
            call.resolve(["requested": true])
        }
    }

    @MainActor private func activeWindowScene() -> UIWindowScene? {
        if let scene = bridge?.viewController?.view.window?.windowScene,
           scene.activationState == .foregroundActive {
            return scene
        }
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
    }
}
