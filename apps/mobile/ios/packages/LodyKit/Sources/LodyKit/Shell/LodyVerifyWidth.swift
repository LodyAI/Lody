import notify
import UIKit

// UI checks reach iPad multitasking and iPhone Duo width changes by overriding
// each window's size class; the window keeps its real bounds.
enum LodyVerifyWidth {
  private nonisolated(unsafe) static var tokens: [Int32] = []

  @MainActor static func install() {
    guard LodyUIVerify.enabled else { return }
    for width in ["compact", "regular", "system"] {
      var token: Int32 = 0
      notify_register_dispatch("ai.lody.mobile.verify.width.\(width)", &token, .main) { _ in
        MainActor.assumeIsolated { apply(width) }
      }
      tokens.append(token)
    }
  }

  @MainActor private static func apply(_ width: String) {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    NSLog("[verify-width] %@ on %d windows", width, windows.count)
    for window in windows {
      switch width {
      case "compact": window.traitOverrides.horizontalSizeClass = .compact
      case "regular": window.traitOverrides.horizontalSizeClass = .regular
      default: window.traitOverrides.remove(UITraitHorizontalSizeClass.self)
      }
    }
  }
}
