import UIKit

final class LodyToastPillView: UIView {
  let message: String
  let hasAction: Bool
  private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
  private let glyph = UIImageView()
  private let label = UILabel()
  private let actionButton: UIButton?
  private let drawsCheckmark: Bool
  private var playedGlyph = false
  var onAction: (() -> Void)?

  var showsContent = true {
    didSet {
      label.isHidden = !showsContent
      glyph.isHidden = !showsContent
      actionButton?.isHidden = !showsContent
      isAccessibilityElement = showsContent && actionButton == nil
      accessibilityElementsHidden = !showsContent
    }
  }

  init(message: String, symbol: String, tint: UIColor, actionTitle: String? = nil) {
    self.message = message
    hasAction = actionTitle != nil
    drawsCheckmark = symbol == "checkmark"
    if let actionTitle {
      let action = UIButton(type: .system)
      action.setTitle(actionTitle, for: .normal)
      action.titleLabel?.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(
        for: .systemFont(ofSize: 15, weight: .semibold)
      )
      action.titleLabel?.adjustsFontForContentSizeCategory = true
      action.tintColor = .systemBlue
      action.accessibilityIdentifier = "lody.toast.undo"
      action.accessibilityLabel = actionTitle
      actionButton = action
    } else {
      actionButton = nil
    }
    super.init(frame: .zero)
    layer.cornerCurve = .continuous
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.08
    layer.shadowRadius = 12
    layer.shadowOffset = CGSize(width: 0, height: 4)
    blur.clipsToBounds = true
    blur.layer.cornerCurve = .continuous
    addSubview(blur)

    label.text = message
    label.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(
      for: .systemFont(ofSize: 15, weight: .medium)
    )
    label.adjustsFontForContentSizeCategory = true
    label.textColor = .label
    label.numberOfLines = 0
    blur.contentView.addSubview(label)

    glyph.image = UIImage(systemName: symbol)?
      .withConfiguration(UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
    glyph.tintColor = tint
    glyph.contentMode = .center
    blur.contentView.addSubview(glyph)

    if let actionButton {
      actionButton.addTarget(self, action: #selector(handleAction), for: .touchUpInside)
      blur.contentView.addSubview(actionButton)
      isAccessibilityElement = false
      accessibilityIdentifier = "lody.toast"
    } else {
      isAccessibilityElement = true
      accessibilityIdentifier = "lody.toast"
      accessibilityLabel = message
      accessibilityTraits = .staticText
    }
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
    let actionWidth = self.actionWidth
    let text = label.sizeThatFits(
      CGSize(width: max(1, maxWidth - 64 - actionWidth), height: .greatestFiniteMagnitude)
    )
    let minHeight: CGFloat
    if actionButton == nil {
      minHeight = 48
    } else {
      minHeight = 52
    }
    return CGSize(
      width: min(maxWidth, ceil(text.width) + 64 + actionWidth),
      height: max(minHeight, ceil(text.height) + 24)
    )
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let radius = min(24, bounds.height / 2)
    layer.cornerRadius = radius
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: radius).cgPath
    blur.frame = bounds
    blur.layer.cornerRadius = radius
    glyph.frame = CGRect(x: 18, y: (bounds.height - 18) / 2, width: 18, height: 18)
    if let actionButton {
      let width = actionWidth
      actionButton.frame = CGRect(
        x: bounds.width - width - 8,
        y: (bounds.height - 44) / 2,
        width: width,
        height: 44
      )
      label.frame = CGRect(x: 46, y: 12, width: max(0, actionButton.frame.minX - 54), height: bounds.height - 24)
    } else {
      label.frame = CGRect(x: 46, y: 12, width: max(0, bounds.width - 64), height: bounds.height - 24)
    }
  }

  private var actionWidth: CGFloat {
    guard let actionButton else { return 0 }
    return max(44, ceil(actionButton.intrinsicContentSize.width) + 16)
  }

  @objc private func handleAction() {
    triggerAction()
  }

  func triggerAction() {
    onAction?()
  }
}
