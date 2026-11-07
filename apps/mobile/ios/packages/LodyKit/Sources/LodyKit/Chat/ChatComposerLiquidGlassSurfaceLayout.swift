import LodyDesignSystem
import UIKit

final class ChatComposerLiquidGlassSurfaceLayout: ChatComposerSurfaceLayout {
  static let sheetCornerRadius: CGFloat = 28
  // The iOS 26 keyboard has rounded top corners; material continuing behind it keeps the sheet from showing a seam there.
  static let sheetBleed: CGFloat = 40
  private let inputSurface: UIVisualEffectView
  private let pill: [NSLayoutConstraint]
  private let sheet: [NSLayoutConstraint]
  private var isFocused = false
  /// The new-session page's composer: the same Liquid Glass surface, but it stays a rounded card
  /// while typing (no keyboard-sheet morph), with its controls row always shown.
  private var card = false
  /// Room kept below the surface for the mention panel docked on the keyboard.
  private var bottomInset: CGFloat = 0

  init(container: UIVisualEffectView, inputSurface: UIVisualEffectView) {
    self.inputSurface = inputSurface
    let containerEffect = UIGlassContainerEffect()
    containerEffect.spacing = 8
    container.effect = containerEffect
    let glass = UIGlassEffect(style: .regular)
    glass.isInteractive = true
    inputSurface.effect = glass
    let host = container.contentView
    pill = [
      inputSurface.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 20),
      inputSurface.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -20),
      inputSurface.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: -8),
    ]
    sheet = [
      inputSurface.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      inputSurface.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      inputSurface.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: Self.sheetBleed),
    ]
  }

  func activate() {
    NSLayoutConstraint.activate(pill)
    applyCorners()
  }

  /// With the mention panel docked, the surface ends above it (no keyboard bleed).
  func setBottomInset(_ inset: CGFloat) {
    guard bottomInset != inset else { return }
    bottomInset = inset
    applyBottom()
  }

  private func applyBottom() {
    for constraint in pill where constraint.firstAttribute == .bottom { constraint.constant = -8 - bottomInset }
    for constraint in sheet where constraint.firstAttribute == .bottom {
      constraint.constant = bottomInset > 0 ? -bottomInset : Self.sheetBleed
    }
  }

  func setCard(_ on: Bool) {
    guard card != on else { return }
    card = on
    if on {
      NSLayoutConstraint.deactivate(sheet)
      NSLayoutConstraint.activate(pill)
      for constraint in pill where constraint.firstAttribute != .bottom {
        constraint.constant = constraint.firstAttribute == .leading ? LodyLayout.screenPaddingX : -LodyLayout.screenPaddingX
      }
    }
    applyCorners()
  }

  func update(isFocused: Bool) {
    guard !card else { return }
    guard self.isFocused != isFocused else { return }
    self.isFocused = isFocused
    NSLayoutConstraint.deactivate(isFocused ? pill : sheet)
    NSLayoutConstraint.activate(isFocused ? sheet : pill)
    applyCorners()
  }

  private func applyCorners() {
    if card {
      inputSurface.cornerConfiguration = .capsule(maximumRadius: 24)
    } else if isFocused {
      let top = UICornerRadius.fixed(Self.sheetCornerRadius)
      inputSurface.cornerConfiguration = .corners(topLeftRadius: top, topRightRadius: top, bottomLeftRadius: .fixed(0), bottomRightRadius: .fixed(0))
    } else {
      inputSurface.cornerConfiguration = .capsule(maximumRadius: 24)
    }
  }
}
