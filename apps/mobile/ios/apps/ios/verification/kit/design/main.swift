import UIKit
import LodyDesignSystem

func luminance(_ color: UIColor) -> CGFloat {
  var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
  color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
  func linear(_ value: CGFloat) -> CGFloat {
    value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

func over(_ color: UIColor, _ ground: UIColor) -> UIColor {
  var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
  var groundRed: CGFloat = 0, groundGreen: CGFloat = 0, groundBlue: CGFloat = 0, groundAlpha: CGFloat = 0
  color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
  ground.getRed(&groundRed, green: &groundGreen, blue: &groundBlue, alpha: &groundAlpha)
  return UIColor(
    red: red * alpha + groundRed * (1 - alpha),
    green: green * alpha + groundGreen * (1 - alpha),
    blue: blue * alpha + groundBlue * (1 - alpha),
    alpha: 1
  )
}

func contrast(_ color: UIColor, _ ground: UIColor, _ traits: UITraitCollection) -> CGFloat {
  let resolvedGround = ground.resolvedColor(with: traits)
  let front = luminance(over(color.resolvedColor(with: traits), resolvedGround))
  let back = luminance(resolvedGround)
  return (max(front, back) + 0.05) / (min(front, back) + 0.05)
}

func same(_ left: UIColor, _ right: UIColor, _ traits: UITraitCollection) -> Bool {
  left.resolvedColor(with: traits) == right.resolvedColor(with: traits)
}

let light = UITraitCollection(userInterfaceStyle: .light)
let dark = UITraitCollection(userInterfaceStyle: .dark)
let lightHigh = UITraitCollection(traitsFrom: [light, UITraitCollection(accessibilityContrast: .high)])
let darkHigh = UITraitCollection(traitsFrom: [dark, UITraitCollection(accessibilityContrast: .high)])

for background in ["", "soft", "black", "unknown"] {
  UserDefaults.standard.set(background, forKey: "darkBackground")
  for traits in [light, dark, lightHigh, darkHigh] {
    let soft = UIColor(red: 17.0 / 255, green: 17.0 / 255, blue: 19.0 / 255, alpha: 1)
    let expected = traits.userInterfaceStyle == .dark ? soft : UIColor.systemBackground
    let grouped = traits.userInterfaceStyle == .dark ? soft : UIColor.systemGroupedBackground
    for canvas in [UIColor.lodyBackground, .lodyOpaqueBackground] {
      precondition(same(canvas, expected, traits), "Legacy background preferences cannot change the opaque canvas")
    }
    precondition(same(.lodyGroupedBackground, grouped, traits))
    precondition(same(.lodySoftDarkBackground, soft, traits), "Camera surfaces stay soft dark even in light mode")
    if traits.userInterfaceStyle == .dark {
      precondition(same(LodyUIColor.bgBase, soft, traits))
      precondition(same(LodyUIColor.bgGrouped, soft, traits))
    }
    precondition(contrast(.white, .lodySoftDarkBackground, traits) >= 7, "Camera controls remain readable")
    precondition(same(.lodyGround, .lodyBackground, traits), "The design ground is the system Lody background")
    precondition(contrast(.lodyInk, .lodyGround, traits) >= 12, "Ink reads as primary text")
    precondition(contrast(.lodySecondary, .lodyGround, traits) >= 4.5, "Secondary text meets 4.5:1 on \(background)")
    precondition(contrast(.lodyAttention, .lodyGround, traits) >= 3, "The attention glyph meets 3:1 on \(background)")
    precondition(contrast(.lodyFailure, .lodyGround, traits) >= 3, "The failure glyph meets 3:1 on \(background)")
  }
  for traits in [lightHigh, darkHigh] {
    precondition(contrast(.lodyTertiary, .lodyGround, traits) >= 4.5, "Increased contrast lifts tertiary text to 4.5:1")
  }
  precondition(contrast(.lodyRail, .lodyGround, dark) > contrast(.lodyLine, .lodyGround, dark), "Tree lines read above hairlines")
}
UserDefaults.standard.removeObject(forKey: "darkBackground")

let regular = UITraitCollection(preferredContentSizeCategory: .large)
let larger = UITraitCollection(preferredContentSizeCategory: .accessibilityLarge)
let mono = LodyDesign.mono(11.5, compatibleWith: regular)
precondition(mono.fontDescriptor.symbolicTraits.contains(.traitMonoSpace), "Metadata uses a monospaced face")
precondition(LodyDesign.mono(11.5, compatibleWith: larger).pointSize > mono.pointSize, "Mono metadata follows Dynamic Type")
precondition(abs(mono.pointSize - 11.5) <= 0.5, "The default size stays at the designed metric: \(mono.pointSize)")
let title = LodyDesign.font(.subheadline, size: 15, weight: .semibold, compatibleWith: regular)
precondition(LodyDesign.font(.subheadline, size: 15, weight: .semibold, compatibleWith: larger).pointSize > title.pointSize)

precondition(LodyDesign.Rail.center == 24 && LodyDesign.Rail.text == 46)
precondition(LodyDesign.Rail.childCenter == 46 && LodyDesign.Rail.childText == 62)
precondition(LodyDesign.Rail.trailing == 16)
precondition(LodyDesign.Rail.groupGap > LodyDesign.Rail.sectionGap && LodyDesign.Rail.sectionGap >= 8,
             "Groups stand further apart than sibling projects")
precondition(LodyDesign.Rail.groupGap <= 16, "Labeled groups sit one small step apart; the header label already marks the break")
precondition(LodyDesign.Rail.bandGap < LodyDesign.Rail.sectionGap,
             "Banded groups need less air than labeled ones")
let savedAccent = UserDefaults.standard.object(forKey: "accentColor")
for legacy in ["", "blue", "purple", "pink", "#FFFFAA", "#123ABC", "unknown"] {
  UserDefaults.standard.set(legacy, forKey: "accentColor")
  for background in ["soft", "black"] {
    UserDefaults.standard.set(background, forKey: "darkBackground")
    for traits in [light, dark, lightHigh, darkHigh] {
      precondition(same(LodyAccent.color, .lodyInk, traits), "Legacy preferences cannot change Ink")
      precondition(same(LodyAccent.foregroundColor, .lodyGround, traits))
      precondition(contrast(LodyAccent.foregroundColor, LodyAccent.color, traits) >= 7)
      precondition(same(.lodyAccent, .lodyInk, traits))
      precondition(same(.lodyUserBubble, .lodyInset, traits))
      let button = UIButton.Configuration.lodyProminent()
      precondition(same(button.baseBackgroundColor!, .lodyInk, traits))
      precondition(same(button.baseForegroundColor!, .lodyGround, traits))
    }
  }
}
UserDefaults.standard.set(savedAccent, forKey: "accentColor")
UserDefaults.standard.removeObject(forKey: "darkBackground")
print("design ok")
