import UIKit

extension UIFont {
  static func dynamicScale(compatibleWith traits: UITraitCollection? = nil) -> CGFloat {
    let body = preferredFont(forTextStyle: .body, compatibleWith: traits ?? .current).pointSize
    return min(23 / 17, max(14 / 17, body / 17))
  }

  static func dynamic(
    of size: CGFloat,
    weight: UIFont.Weight = .regular,
    compatibleWith traits: UITraitCollection? = nil
  ) -> UIFont {
    systemFont(ofSize: size * dynamicScale(compatibleWith: traits), weight: weight)
  }

  static func lodySFMono(ofSize size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
    let names = [
      UIFont.Weight.medium: "SFMono-Medium",
      .semibold: "SFMono-Semibold",
      .bold: "SFMono-Bold",
    ]
    if let name = names[weight], let font = UIFont(name: name, size: size) {
      return font
    }
    if let font = UIFont(name: "SFMono-Regular", size: size) {
      return font
    }
    if let descriptor = systemFont(ofSize: size, weight: weight).fontDescriptor.withDesign(.monospaced) {
      return UIFont(descriptor: descriptor, size: size)
    }
    return monospacedSystemFont(ofSize: size, weight: weight)
  }

  func withTabularNumbers() -> UIFont {
    let weight = (fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any])
      .flatMap { $0[.weight] as? CGFloat }
      .map(UIFont.Weight.init(rawValue:)) ?? .regular
    return .monospacedDigitSystemFont(ofSize: pointSize, weight: weight)
  }
}
