import UIKit

/// The theme the user committed in the app, as the shell needs it before the
/// WebView has run a line of JavaScript.
///
/// Two surfaces read it. `SceneDelegate` sets `overrideUserInterfaceStyle` on the
/// window from it, which makes the Capacitor splash — a view the plugin
/// instantiates from `LaunchScreen.storyboard` — resolve `systemBackgroundColor`
/// against the app's theme rather than the system's. `LodyBridgeViewController`
/// paints the WebView background from it so nothing white shows between the
/// splash fading out and the page's own first paint.
///
/// The static launch image iOS shows during the icon zoom is drawn before any of
/// this runs and follows the system appearance; that is by design and matches
/// the HIG. It lasts one animation.
enum LodyStartupTheme: String {
    case light
    case dark
    case system

    static let defaultsKey = "lody.startupTheme"

    /// Tracks `--background` in the shared theme: Lody Light and Vesper.
    private static let lightBackground = UIColor(red: 1, green: 1, blue: 1, alpha: 1)
    private static let darkBackground = UIColor(red: 0x10 / 255, green: 0x10 / 255, blue: 0x10 / 255, alpha: 1)

    static func load(from defaults: UserDefaults = .standard) -> LodyStartupTheme {
        guard let raw = defaults.string(forKey: defaultsKey), let theme = LodyStartupTheme(rawValue: raw) else {
            return .system
        }
        return theme
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.defaultsKey)
    }

    var interfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .light: return .light
        case .dark: return .dark
        case .system: return .unspecified
        }
    }

    /// The color the WebView should show before the page paints, resolved
    /// against the trait the window actually ended up with.
    func backgroundColor(for traits: UITraitCollection) -> UIColor {
        switch self {
        case .light: return Self.lightBackground
        case .dark: return Self.darkBackground
        case .system: return traits.userInterfaceStyle == .dark ? Self.darkBackground : Self.lightBackground
        }
    }

    @MainActor static func apply(_ theme: LodyStartupTheme, to window: UIWindow?) {
        window?.overrideUserInterfaceStyle = theme.interfaceStyle
    }
}
