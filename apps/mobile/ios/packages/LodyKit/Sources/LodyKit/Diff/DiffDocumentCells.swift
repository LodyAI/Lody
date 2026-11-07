import UIKit

struct DiffDocumentSide {
  var kind: InlineDiffLine.Kind?
  var number: Int?
  var text: NSAttributedString
  var selected = false
}

final class DiffDocumentSideView: UIView {
  private let codeBand = UIView()
  private let gutterBase = UIView()
  private let gutterBand = UIView()
  private let bar = UIView()
  private let number = UILabel()
  private let code = UILabel()
  private var geometry = DiffDocumentGeometry(wrap: true, numberWidth: 0, sideWidth: 0, contentWidth: 0)
  private var textWidth: CGFloat = 0
  var pin: CGFloat = 0 {
    didSet { if pin != oldValue { setNeedsLayout() } }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    gutterBase.backgroundColor = .systemBackground
    number.textAlignment = .right
    code.numberOfLines = 0
    for view in [codeBand, code, gutterBase, gutterBand, bar, number] as [UIView] {
      addSubview(view)
    }
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func apply(_ side: DiffDocumentSide?, geometry: DiffDocumentGeometry, textWidth: CGFloat) {
    self.geometry = geometry
    self.textWidth = textWidth
    let kind = side?.kind ?? .context
    let selection = Self.selectionTint
    codeBand.backgroundColor = side == nil ? .quaternarySystemFill : InlineDiffRenderer.lineTint(for: kind)
    gutterBand.backgroundColor = side == nil ? .quaternarySystemFill : InlineDiffRenderer.gutterTint(for: kind)
    if side?.selected == true {
      codeBand.backgroundColor = selection
      gutterBand.backgroundColor = selection
    }
    bar.backgroundColor = InlineDiffRenderer.barColor(for: kind)
    let selected = side?.selected == true
    number.font = UIFont.lodySFMono(ofSize: InlineDiffMetrics.fontSize, weight: selected ? .semibold : .regular)
    number.textColor = selected ? .systemBlue : .tertiaryLabel
    number.text = side?.number.map(String.init)
    code.attributedText = side?.text
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let height = bounds.height
    let inset = DiffDocumentGeometry.lineGap / 2
    let gutter = geometry.gutterWidth
    codeBand.frame = CGRect(x: gutter, y: 0, width: max(0, bounds.width - gutter), height: height)
    let codeWidth = geometry.wrap ? geometry.codeWidth : max(textWidth, geometry.codeWidth)
    let fitted = code.sizeThatFits(CGSize(width: codeWidth, height: .greatestFiniteMagnitude)).height
    code.frame = CGRect(x: geometry.codeX, y: inset, width: codeWidth, height: min(ceil(fitted), max(0, height - inset * 2)))
    gutterBase.frame = CGRect(x: pin, y: 0, width: gutter, height: height)
    gutterBand.frame = gutterBase.frame
    bar.frame = CGRect(x: pin, y: 0, width: InlineDiffMetrics.barWidth, height: height)
    number.frame = CGRect(
      x: pin + InlineDiffMetrics.barWidth + 4,
      y: inset,
      width: geometry.numberWidth,
      height: InlineDiffMetrics.font().lineHeight
    )
  }

  private static let selectionTint = UIColor { traits in
    UIColor.systemBlue.withAlphaComponent(traits.userInterfaceStyle == .dark ? 0.30 : 0.20)
  }
}

final class DiffDocumentLineCell: UICollectionViewCell {
  static let reuse = "diff-line"
  private let left = DiffDocumentSideView()
  private let right = DiffDocumentSideView()
  private var split = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(left)
    contentView.addSubview(right)
    isAccessibilityElement = true
    accessibilityIdentifier = "diff-line"
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  var pin: CGFloat {
    get { left.pin }
    set { left.pin = newValue }
  }

  func apply(left: DiffDocumentSide?, right: DiffDocumentSide?, split: Bool, geometry: DiffDocumentGeometry, textWidth: CGFloat, label: String) {
    self.split = split
    self.left.apply(left, geometry: geometry, textWidth: textWidth)
    self.right.isHidden = !split
    if split { self.right.apply(right, geometry: geometry, textWidth: textWidth) }
    accessibilityLabel = label
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let bounds = contentView.bounds
    guard split else {
      left.frame = bounds
      return
    }
    let half = floor(bounds.width / 2)
    left.frame = CGRect(x: 0, y: 0, width: half, height: bounds.height)
    right.frame = CGRect(x: half, y: 0, width: bounds.width - half, height: bounds.height)
  }
}

final class DiffDocumentGapCell: UICollectionViewCell {
  static let reuse = "diff-gap"
  private let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.backgroundColor = .tertiarySystemFill
    label.font = .systemFont(ofSize: 12)
    label.textColor = .secondaryLabel
    contentView.addSubview(label)
    isAccessibilityElement = true
    accessibilityTraits = .button
    accessibilityIdentifier = "diff-gap"
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func apply(count: Int) {
    let text = String.localizedStringWithFormat(String(localized: "native.diff.unmodified", bundle: .lody), count)
    label.text = text
    accessibilityLabel = text
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = contentView.bounds.insetBy(dx: 16, dy: 0)
  }
}
