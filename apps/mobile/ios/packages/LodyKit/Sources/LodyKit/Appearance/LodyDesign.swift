import UIKit

enum LodyDesign {
  enum Rail {
    static let center: CGFloat = 24
    static let text: CGFloat = 46
    static let childCenter: CGFloat = 46
    static let childText: CGFloat = 62
    static let compactCenter: CGFloat = 10
    static let compactText: CGFloat = 22
    static let compactChildCenter: CGFloat = 28
    static let compactChildText: CGFloat = 40
    static let trailing: CGFloat = 16
    static let primaryHeight: CGFloat = 52
    static let childHeight: CGFloat = 40
    static let headerHeight: CGFloat = 30
    static let sectionGap: CGFloat = 12
    static let groupGap: CGFloat = 16
    static let compactSectionGap: CGFloat = 8
    static let compactGroupGap: CGFloat = 14
    static let bandGap: CGFloat = 8
    static let compactBandGap: CGFloat = 6
    static let glyph: CGFloat = 14
  }

  static func font(
    _ style: UIFont.TextStyle, size: CGFloat, weight: UIFont.Weight = .regular, compatibleWith traits: UITraitCollection? = nil
  ) -> UIFont {
    UIFontMetrics(forTextStyle: style).scaledFont(for: .systemFont(ofSize: size, weight: weight), compatibleWith: traits)
  }

  static func mono(_ size: CGFloat, weight: UIFont.Weight = .regular, compatibleWith traits: UITraitCollection? = nil) -> UIFont {
    UIFontMetrics(forTextStyle: .footnote).scaledFont(
      for: .monospacedSystemFont(ofSize: size, weight: weight), compatibleWith: traits
    )
  }

  fileprivate static func dynamic(light: UInt32, dark: UInt32, lightHigh: UInt32, darkHigh: UInt32) -> UIColor {
    UIColor { traits in
      let high = traits.accessibilityContrast == .high
      if traits.userInterfaceStyle == .dark { return rgb(high ? darkHigh : dark) }
      return rgb(high ? lightHigh : light)
    }
  }

  fileprivate static func wash(light: CGFloat, dark: CGFloat) -> UIColor {
    UIColor { traits in
      let high: CGFloat = traits.accessibilityContrast == .high ? 1.5 : 1
      return traits.userInterfaceStyle == .dark
        ? UIColor(white: 1, alpha: dark * high)
        : UIColor(white: 0, alpha: light * high)
    }
  }

  private static func rgb(_ value: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: 1
    )
  }
}

extension UIColor {
  static let lodyGround = UIColor.lodyBackground
  static let lodyInk = LodyDesign.dynamic(light: 0x18181B, dark: 0xF2F2F4, lightHigh: 0x000000, darkHigh: 0xFFFFFF)
  static let lodySecondary = LodyDesign.dynamic(light: 0x6E6E76, dark: 0x9C9CA5, lightHigh: 0x4E4E55, darkHigh: 0xBDBDC5)
  static let lodyTertiary = LodyDesign.dynamic(light: 0xA1A1A8, dark: 0x6A6A73, lightHigh: 0x66666D, darkHigh: 0xA4A4AC)
  static let lodyLine = LodyDesign.wash(light: 0.06, dark: 0.08)
  static let lodyLine2 = LodyDesign.wash(light: 0.12, dark: 0.16)
  static let lodyRail = LodyDesign.wash(light: 0.16, dark: 0.18)
  static let lodySelection = LodyDesign.wash(light: 0.06, dark: 0.10)
  static let lodyPress = LodyDesign.wash(light: 0.04, dark: 0.06)
  static let lodyBand = LodyDesign.wash(light: 0.045, dark: 0.07)
  static let lodyBandPressed = LodyDesign.wash(light: 0.09, dark: 0.13)
  static let lodyAttention = LodyDesign.dynamic(light: 0xC47208, dark: 0xF2A33A, lightHigh: 0x9A5800, darkHigh: 0xFFB54D)
  static let lodyFailure = UIColor.systemRed
}
