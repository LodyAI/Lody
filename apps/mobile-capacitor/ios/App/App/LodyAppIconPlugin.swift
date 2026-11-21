import Capacitor
import UIKit

@objc(LodyAppIconPlugin)
public final class LodyAppIconPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LodyAppIconPlugin"
    public let jsName = "LodyAppIcon"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setIcon", returnType: CAPPluginReturnPromise),
    ]

    @MainActor private var isChangingIcon = false

    @MainActor private func state() -> [String: Any] {
        [
            "supported": UIApplication.shared.supportsAlternateIcons,
            "name": UIApplication.shared.alternateIconName ?? "default",
        ]
    }

    @objc public func getState(_ call: CAPPluginCall) {
        Task { @MainActor in
            call.resolve(self.state())
        }
    }

    @objc public func setIcon(_ call: CAPPluginCall) {
        guard let name = call.getString("name"),
              name == "default" || name == "AppIconBlue" else {
            call.reject("Unknown app icon.")
            return
        }

        Task { @MainActor in
            let app = UIApplication.shared
            guard app.supportsAlternateIcons else {
                call.reject("Alternate app icons are not supported.")
                return
            }
            guard !self.isChangingIcon else {
                call.reject("An app icon change is already in progress.")
                return
            }
            let alternateName: String? = name == "default" ? nil : name
            guard app.alternateIconName != alternateName else {
                call.resolve(self.state())
                return
            }
            self.isChangingIcon = true
            defer { self.isChangingIcon = false }
            do {
                try await app.setAlternateIconName(alternateName)
                call.resolve(self.state())
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}
