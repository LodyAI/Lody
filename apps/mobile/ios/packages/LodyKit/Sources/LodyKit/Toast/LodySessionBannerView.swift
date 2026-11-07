import UIKit

enum LodySessionBannerKind: String {
  case completed
  case attention

  var symbolName: String {
    switch self {
    case .completed: "checkmark"
    case .attention: "exclamationmark"
    }
  }

  var subtitleKey: String {
    switch self {
    case .completed: "native.session.banner.completed"
    case .attention: "native.session.banner.attention"
    }
  }

  var sticky: Bool { self == .attention }

  var feedback: UINotificationFeedbackGenerator.FeedbackType {
    switch self {
    case .completed: .success
    case .attention: .warning
    }
  }

  var glyphColor: UIColor {
    switch self {
    case .completed: .systemGray
    case .attention: .systemOrange
    }
  }
}

final class LodySessionBannerView: UIVisualEffectView {
  var onDismiss: (() -> Void)?
  var onTap: (() -> Void)?
  private let titleLabel = UILabel()
  private let subtitleLabel = UILabel()
  private let glyph = UIImageView()
  private let drawsCheckmark: Bool
  private var playedGlyph = false
  private var dragOffset: CGFloat = 0

  init(title: String, kind: LodySessionBannerKind) {
    drawsCheckmark = kind == .completed
    super.init(effect: nil)
    let glass = UIGlassEffect(style: .regular)
    glass.isInteractive = true
    effect = glass
    cornerConfiguration = .corners(radius: .fixed(18))

    glyph.image = UIImage(systemName: kind.symbolName)
    glyph.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
    glyph.tintColor = .white
    glyph.backgroundColor = kind.glyphColor
    glyph.contentMode = .center
    glyph.layer.cornerRadius = 8
    glyph.layer.cornerCurve = .continuous
    glyph.clipsToBounds = true

    titleLabel.text = title
    titleLabel.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(
      for: .systemFont(ofSize: 15, weight: .semibold)
    )
    titleLabel.adjustsFontForContentSizeCategory = true
    titleLabel.textColor = .label
    titleLabel.numberOfLines = 1
    titleLabel.lineBreakMode = .byTruncatingTail

    subtitleLabel.text = String(localized: String.LocalizationValue(kind.subtitleKey), bundle: .lody)
    subtitleLabel.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(
      for: .systemFont(ofSize: 13, weight: .regular)
    )
    subtitleLabel.adjustsFontForContentSizeCategory = true
    subtitleLabel.textColor = .secondaryLabel
    subtitleLabel.numberOfLines = 1

    contentView.addSubview(glyph)
    contentView.addSubview(titleLabel)
    contentView.addSubview(subtitleLabel)

    isAccessibilityElement = true
    accessibilityIdentifier = "lody.session.banner"
    accessibilityTraits = .button
    accessibilityLabel = [title, subtitleLabel.text].compactMap { $0 }.joined(separator: ", ")
    accessibilityHint = String(localized: "native.session.banner.openHint", bundle: .lody)

    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
    let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan))
    addGestureRecognizer(tap)
    addGestureRecognizer(pan)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, drawsCheckmark, !playedGlyph else { return }
    playedGlyph = true
    glyph.playDrawOnSymbol()
  }

  func fittedSize(maxWidth: CGFloat) -> CGSize {
    let textWidth = max(1, maxWidth - 64)
    let title = titleLabel.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude))
    let subtitle = subtitleLabel.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude))
    return CGSize(
      width: maxWidth,
      height: max(52, ceil(title.height + subtitle.height + 22))
    )
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    glyph.frame = CGRect(x: 12, y: (bounds.height - 32) / 2, width: 32, height: 32)
    let textX: CGFloat = 52
    let textW = max(0, bounds.width - textX - 12)
    let titleH = titleLabel.sizeThatFits(CGSize(width: textW, height: .greatestFiniteMagnitude)).height
    let subH = subtitleLabel.sizeThatFits(CGSize(width: textW, height: .greatestFiniteMagnitude)).height
    let y = (bounds.height - titleH - 2 - subH) / 2
    titleLabel.frame = CGRect(x: textX, y: y, width: textW, height: titleH)
    subtitleLabel.frame = CGRect(x: textX, y: y + titleH + 2, width: textW, height: subH)
  }

  override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
    guard let pan = gesture as? UIPanGestureRecognizer else { return true }
    let velocity = pan.velocity(in: self)
    return abs(velocity.y) > abs(velocity.x)
  }

  override func accessibilityPerformEscape() -> Bool {
    onDismiss?()
    return true
  }

  @objc private func handleTap() {
    onTap?()
  }

  @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
    let translation = gesture.translation(in: self).y
    switch gesture.state {
    case .changed:
      dragOffset = translation < 0 ? translation : translation / (translation + 120) * 40
      transform = CGAffineTransform(translationX: 0, y: dragOffset)
    case .ended, .cancelled:
      if gesture.state == .ended && (translation < -40 || gesture.velocity(in: self).y < -600) {
        onDismiss?()
      } else {
        dragOffset = 0
        UIView.animate(
          withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.3,
          delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: 0,
          options: [.beginFromCurrentState, .allowUserInteraction]
        ) { self.transform = .identity }
      }
    default:
      break
    }
  }
}

extension UIImageView {
  func playDrawOnSymbol() {
    guard !UIAccessibility.isReduceMotionEnabled else { return }
    addSymbolEffect(.drawOn, options: .nonRepeating)
  }
}
