import Capacitor
import UIKit

/// Receives the committed theme from the shared `ThemeProvider`
/// (`window.__LODY_STARTUP_THEME__.persist`) and does two things with it: stores
/// it for the next launch, and applies it to the live window so native surfaces
/// the WebView cannot style — the keyboard, share and action sheets — match the
/// app immediately instead of after a restart.
@objc(LodyStartupThemePlugin)
public final class LodyStartupThemePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LodyStartupThemePlugin"
    public let jsName = "LodyStartupTheme"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "persist", returnType: CAPPluginReturnPromise),
    ]

    @objc public func persist(_ call: CAPPluginCall) {
        guard let raw = call.getString("theme"), let theme = LodyStartupTheme(rawValue: raw) else {
            call.reject("theme must be one of light, dark, system")
            return
        }
        theme.save()
        Task { @MainActor [weak self] in
            let window = self?.bridge?.viewController?.view.window
            LodyStartupTheme.apply(theme, to: window)
            (self?.bridge?.viewController as? LodyBridgeViewController)?.applyStartupThemeBackground(theme)
            call.resolve()
        }
    }
}
