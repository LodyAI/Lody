import UIKit

enum LodyAccent {
  static let color = UIColor.lodyInk
  static let foregroundColor = UIColor.lodyGround

  static func hex(_ color: UIColor) -> String {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    return String(format: "#%02X%02X%02X", Int(min(255, max(0, (red * 255).rounded()))), Int(min(255, max(0, (green * 255).rounded()))), Int(min(255, max(0, (blue * 255).rounded()))))
  }
}

extension Notification.Name {
  static let lodyAppearanceDidChange = Notification.Name("LodyAppearanceDidChange")
}

func lodyTint(_ value: String) -> UIColor? {
  switch value {
  case "": return nil
  case "blue": return UIColor.lodyAccent
  case "systemBlue": return .systemBlue
  case "green": return .systemGreen
  case "purple": return .systemPurple
  case "warning": return .systemOrange
  case "danger": return .systemRed
  case "yellow": return .systemYellow
  case "label": return .label
  case "secondary": return .secondaryLabel
  case "tertiary": return .tertiaryLabel
  default: break
  }
  var hex = value
  if hex.hasPrefix("#") { hex.removeFirst() }
  guard hex.count == 6, let rgb = UInt32(hex, radix: 16) else { return nil }
  return UIColor(
    red: CGFloat((rgb >> 16) & 0xFF) / 255,
    green: CGFloat((rgb >> 8) & 0xFF) / 255,
    blue: CGFloat(rgb & 0xFF) / 255,
    alpha: 1
  )
}

extension UIColor {
  /// Fixed dark media canvas, including when the device uses light mode.
  static let lodySoftDarkBackground = UIColor(red: 0x11 / 255, green: 0x11 / 255, blue: 0x13 / 255, alpha: 1)

  static let lodyBackground = UIColor { traits in
    if traits.userInterfaceStyle != .dark {
      return UIColor.systemBackground.resolvedColor(with: traits)
    }
    return .lodySoftDarkBackground
  }

  static let lodySidebar = UIColor { traits in
    let high = traits.accessibilityContrast == .high
    if traits.userInterfaceStyle != .dark {
      return UIColor(white: high ? 0xEE / 255 : 0xF7 / 255, alpha: 1)
    }
    return UIColor(white: high ? 0x20 / 255 : 0x18 / 255, alpha: 1)
  }

  static let lodyGroupedBackground = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor.lodyBackground.resolvedColor(with: traits)
      : UIColor.systemGroupedBackground.resolvedColor(with: traits)
  }

  /// Reading canvases remain opaque when moving out of a glass Sheet. Resolve
  /// the semantic color inside the provider to retain automatic theme/contrast
  /// updates without promoting the canvas itself to a vibrant material.
  static let lodyOpaqueBackground = UIColor { traits in
    UIColor.lodyBackground.resolvedColor(with: traits)
  }

  /// Glass sheets resolve grouped semantics to vibrant fills. Rows that still
  /// need to read as cards use these opaque system card values instead.
  static let lodyOpaqueCard = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(red: 0x1C / 255, green: 0x1C / 255, blue: 0x1E / 255, alpha: 1)
      : .white
  }

  static let lodyAccent = UIColor { traits in
    LodyAccent.color.resolvedColor(with: traits)
  }

  static let lodyUserBubble = UIColor { traits in
    UIColor.lodyInset.resolvedColor(with: traits)
  }

  /// Recessed chip on the reading canvas. Light is Tailwind `neutral-100`;
  /// dark matches `secondarySystemBackground` so file cards and code blocks
  /// sit on the soft dark canvas without a mid-grey slab.
  static let lodyInset = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(red: 0x1C / 255, green: 0x1C / 255, blue: 0x1E / 255, alpha: 1)
      : UIColor(red: 0xF5 / 255, green: 0xF5 / 255, blue: 0xF5 / 255, alpha: 1)
  }

  /// Resting inset and selected fill stay a pair so `selectItem` still reads.
  /// Light is Tailwind `neutral-200`; dark is `tertiarySystemBackground`.
  static let lodyInsetSelected = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(red: 0x2C / 255, green: 0x2C / 255, blue: 0x2E / 255, alpha: 1)
      : UIColor(red: 0xE5 / 255, green: 0xE5 / 255, blue: 0xE5 / 255, alpha: 1)
  }

  static let lodyFileGroup = UIColor { traits in
    UIColor.lodyInset.resolvedColor(with: traits)
  }

  static let lodyFileGroupSelected = UIColor { traits in
    UIColor.lodyInsetSelected.resolvedColor(with: traits)
  }
}

@MainActor
func lodyApplyWindowAccent() {
  UIWindow.appearance().tintColor = .lodyAccent
  #if !LODY_SHARE_EXTENSION
  for scene in UIApplication.shared.connectedScenes {
    guard let scene = scene as? UIWindowScene else { continue }
    for window in scene.windows {
      window.tintColor = LodyAccent.color
    }
  }
  #endif
}

extension UIButton.Configuration {
  // Prominent glass draws white titles whatever the foreground, and Ink resolves near-white in dark mode.
  @MainActor static func lodyProminent(font: UIFont? = nil) -> UIButton.Configuration {
    var configuration: UIButton.Configuration = .filled()
    configuration.baseBackgroundColor = LodyAccent.color
    configuration.baseForegroundColor = LodyAccent.foregroundColor
    configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var attributes = attributes
      if let font { attributes.font = font }
      attributes.foregroundColor = LodyAccent.foregroundColor
      return attributes
    }
    return configuration
  }
}
