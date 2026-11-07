import UIKit

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

for background in ["soft", "black"] {
  UserDefaults.standard.set(background, forKey: "darkBackground")
  for traits in [light, dark, lightHigh, darkHigh] {
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
precondition(LodyDesign.Rail.compactCenter == 10 && LodyDesign.Rail.trailing == 16)
precondition(LodyDesign.Rail.groupGap > LodyDesign.Rail.sectionGap && LodyDesign.Rail.sectionGap >= 8,
             "Groups stand further apart than sibling projects")
precondition(LodyDesign.Rail.compactGroupGap > LodyDesign.Rail.compactSectionGap && LodyDesign.Rail.compactGroupGap < LodyDesign.Rail.groupGap,
             "The sidebar keeps the gap hierarchy at a denser scale")
precondition(LodyDesign.Rail.groupGap <= 16, "Labeled groups sit one small step apart; the header label already marks the break")
precondition(LodyDesign.Rail.bandGap < LodyDesign.Rail.sectionGap && LodyDesign.Rail.compactBandGap < LodyDesign.Rail.compactSectionGap,
             "Banded groups need less air than labeled ones")
func hue(_ color: UIColor, _ traits: UITraitCollection) -> CGFloat {
  var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
  color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
  return max(r, g, b) - min(r, g, b)
}
for traits in [light, dark, lightHigh, darkHigh] {
  precondition(hue(.lodySidebar, traits) <= 2.0 / 255, "The sidebar canvas is neutral, not the bluish system gray")
  precondition(hue(.lodySelection, traits) == 0, "Sidebar selection is a neutral wash")
  precondition(!same(.lodySidebar, .secondarySystemBackground, traits))
}
precondition(luminance(UIColor.lodySidebar.resolvedColor(with: light)) < luminance(UIColor.lodyBackground.resolvedColor(with: light)),
             "The light sidebar sits just below the white detail")
for style in ["soft", "black"] {
  UserDefaults.standard.set(style, forKey: "darkBackground")
  precondition(luminance(UIColor.lodySidebar.resolvedColor(with: dark)) > luminance(UIColor.lodyBackground.resolvedColor(with: dark)),
               "The dark sidebar lifts above the \(style) detail")
}
UserDefaults.standard.removeObject(forKey: "darkBackground")
UserDefaults.standard.removeObject(forKey: "accentColor")
precondition(LodyAccentChoice.current == .ink, "Installs without a stored accent follow the Ink default")
precondition(LodyAccentChoice(rawValue: "ink") == .ink && LodyAccentChoice.ink.rawValue == "ink")
UserDefaults.standard.set("blue", forKey: "accentColor")
precondition(LodyAccentChoice.current == .blue, "An explicit accent choice survives the new default")
UserDefaults.standard.removeObject(forKey: "accentColor")
for traits in [light, dark] {
  precondition(same(LodyAccentChoice.ink.color, .lodyInk, traits), "Ink is the ink token")
  precondition(contrast(LodyAccentChoice.ink.foregroundColor, LodyAccentChoice.ink.color, traits) >= 7,
               "Labels on an Ink fill stay legible")
  precondition(same(.lodyAccent, .lodyInk, traits))
  precondition(same(.lodyUserBubble, .lodyInset, traits), "The user bubble is a neutral inset, not an accent tint")
}
UserDefaults.standard.set("pink", forKey: "accentColor")
precondition(same(.lodyUserBubble, .lodyInset, light), "The bubble stays neutral under any accent")
UserDefaults.standard.removeObject(forKey: "accentColor")
print("design ok")
