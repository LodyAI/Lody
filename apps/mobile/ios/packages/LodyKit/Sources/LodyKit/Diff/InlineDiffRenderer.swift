import UIKit

/// Shared 20 pt line box. Numbers and code use the same TextKit 1 view so
/// gutter digits, gutter tint, change bar, and code tint share one row.
enum InlineDiffMetrics {
  static let rowHeight: CGFloat = 20
  static let barWidth: CGFloat = 3
  static let codeInset: CGFloat = 8
  static let verticalPadding: CGFloat = 4
  static let fontSize: CGFloat = 13

  static func font() -> UIFont {
    UIFont.lodySFMono(ofSize: fontSize)
  }

  static var textInsetY: CGFloat {
    max(0, (rowHeight - font().lineHeight) / 2)
  }

  static func attributes(color: UIColor, alignment: NSTextAlignment) -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = alignment
    paragraph.lineBreakMode = .byClipping
    paragraph.minimumLineHeight = font().lineHeight
    paragraph.maximumLineHeight = font().lineHeight
    return [
      .font: font(),
      .foregroundColor: color,
      .paragraphStyle: paragraph,
    ]
  }
}

struct InlineDiffRowProbe {
  let row: CGRect
  let gutter: CGRect
  let code: CGRect
  let bar: CGRect
  let number: CGRect
}

final class InlineDiffRenderer: UIView {
  private var rows: [InlineDiffRow] = []
  private var gutterWidth: CGFloat = 40
  private(set) var contentHeight: CGFloat = 0

  var allowsVerticalScrolling: Bool { false }

  var allowsHorizontalScrolling: Bool {
    rows.contains { $0.allowsHorizontalScrolling }
  }

  var lineViews: [UITextView] {
    rows.map(\.codeView)
  }

  var rowProbes: [InlineDiffRowProbe] {
    rows.map { $0.probe(in: self) }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    backgroundColor = .secondarySystemGroupedBackground
    isAccessibilityElement = false
    accessibilityIdentifier = "inline-diff"
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func render(_ document: InlineDiffDocument, path: String, highlight: Bool) {
    rows.forEach { $0.removeFromSuperview() }
    rows = []
    let font = InlineDiffMetrics.font()
    let lines = document.hunks.flatMap(\.lines)
    let digits = max(2, String(lines.map { max($0.oldNumber ?? 0, $0.newNumber ?? 0) }.max() ?? 0).count)
    let digitWidth = ceil(("8" as NSString).size(withAttributes: [.font: font]).width)
    let numberWidth = digitWidth * CGFloat(digits)
    gutterWidth = InlineDiffMetrics.barWidth + 4 + numberWidth + InlineDiffMetrics.codeInset
    for line in lines {
      let row = InlineDiffRow(numberWidth: numberWidth, gutterWidth: gutterWidth)
      row.apply(line, highlight: highlight)
      addSubview(row)
      rows.append(row)
    }
    contentHeight = max(
      44,
      InlineDiffMetrics.verticalPadding * 2 + InlineDiffMetrics.rowHeight * CGFloat(lines.count)
    )
    invalidateIntrinsicContentSize()
    setNeedsLayout()
    accessibilityLabel = path
  }

  override var intrinsicContentSize: CGSize {
    CGSize(width: UIView.noIntrinsicMetric, height: contentHeight)
  }

  func applyHighlighted(_ texts: [NSAttributedString]) {
    guard texts.count == rows.count else { return }
    for (row, text) in zip(rows, texts) {
      row.applyHighlighted(text)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    for (index, row) in rows.enumerated() {
      row.frame = CGRect(
        x: 0,
        y: InlineDiffMetrics.verticalPadding + InlineDiffMetrics.rowHeight * CGFloat(index),
        width: bounds.width,
        height: InlineDiffMetrics.rowHeight
      )
    }
  }
}

extension InlineDiffRenderer {
  /// Dark mode needs a stronger fade to survive over the grouped card background.
  static func fade(_ base: UIColor, light: CGFloat, dark: CGFloat) -> UIColor {
    UIColor { traits in
      base.withAlphaComponent(traits.userInterfaceStyle == .dark ? dark : light)
    }
  }

  static func lineTint(for kind: InlineDiffLine.Kind) -> UIColor {
    switch kind {
    case .insert: return fade(.systemGreen, light: 0.12, dark: 0.20)
    case .delete: return fade(.systemRed, light: 0.12, dark: 0.20)
    case .context: return .clear
    }
  }

  static func gutterTint(for kind: InlineDiffLine.Kind) -> UIColor {
    switch kind {
    case .insert: return fade(.systemGreen, light: 0.09, dark: 0.15)
    case .delete: return fade(.systemRed, light: 0.09, dark: 0.15)
    case .context: return .clear
    }
  }

  static func emphasisTint(for kind: InlineDiffLine.Kind) -> UIColor {
    switch kind {
    case .insert: return fade(.systemGreen, light: 0.22, dark: 0.32)
    case .delete: return fade(.systemRed, light: 0.22, dark: 0.32)
    case .context: return .clear
    }
  }

  static func barColor(for kind: InlineDiffLine.Kind) -> UIColor {
    switch kind {
    case .insert: return .systemGreen
    case .delete: return .systemRed
    case .context: return .clear
    }
  }
}

/// One line owns bar, numbers, and code so the tint band and glyphs share a
/// single 20 pt box. Only the code side scrolls horizontally.
private final class InlineDiffRow: UIView {
  let codeView = InlineDiffMetrics.makeGlyphView()
  private let gutterBand = UIView()
  private let codeBand = UIView()
  private let bar = UIView()
  private let number = InlineDiffMetrics.makeGlyphView()
  private let codeScroll = UIScrollView()
  private let numberWidth: CGFloat
  private let gutterWidth: CGFloat

  var allowsHorizontalScrolling: Bool {
    codeScroll.contentSize.width > codeScroll.bounds.width + 0.5
  }

  init(numberWidth: CGFloat, gutterWidth: CGFloat) {
    self.numberWidth = numberWidth
    self.gutterWidth = gutterWidth
    super.init(frame: .zero)
    clipsToBounds = true
    isUserInteractionEnabled = true
    addSubview(gutterBand)
    addSubview(codeBand)
    addSubview(bar)
    number.isSelectable = false
    number.isUserInteractionEnabled = false
    number.isAccessibilityElement = false
    addSubview(number)
    codeScroll.alwaysBounceVertical = false
    codeScroll.alwaysBounceHorizontal = true
    codeScroll.showsVerticalScrollIndicator = false
    codeScroll.showsHorizontalScrollIndicator = false
    codeScroll.bounces = true
    codeScroll.isDirectionalLockEnabled = true
    codeScroll.backgroundColor = .clear
    codeView.isSelectable = true
    codeScroll.addSubview(codeView)
    addSubview(codeScroll)
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func apply(_ line: InlineDiffLine, highlight: Bool) {
    number.attributedText = NSAttributedString(
      string: String(line.newNumber ?? line.oldNumber ?? 0),
      attributes: InlineDiffMetrics.attributes(color: .tertiaryLabel, alignment: .right)
    )
    gutterBand.backgroundColor = InlineDiffRenderer.gutterTint(for: line.kind)
    codeBand.backgroundColor = InlineDiffRenderer.lineTint(for: line.kind)
    bar.backgroundColor = InlineDiffRenderer.barColor(for: line.kind)
    let text = NSMutableAttributedString(
      string: line.text.isEmpty ? " " : line.text,
      attributes: InlineDiffMetrics.attributes(color: .label, alignment: .left)
    )
    if highlight {
      for range in line.emphasis where range.location != NSNotFound && NSMaxRange(range) <= text.length {
        text.addAttribute(.backgroundColor, value: InlineDiffRenderer.emphasisTint(for: line.kind), range: range)
      }
    }
    codeView.attributedText = text
    codeView.isAccessibilityElement = false
    isAccessibilityElement = true
    accessibilityIdentifier = "inline-diff-line"
    accessibilityLabel = voiceOver(line)
    setNeedsLayout()
  }

  func applyHighlighted(_ text: NSAttributedString) {
    let styled = NSMutableAttributedString(attributedString: text)
    let range = NSRange(location: 0, length: styled.length)
    let box = InlineDiffMetrics.attributes(color: .label, alignment: .left)
    styled.addAttribute(.paragraphStyle, value: box[.paragraphStyle] as Any, range: range)
    styled.addAttribute(.font, value: box[.font] as Any, range: range)
    styled.removeAttribute(.baselineOffset, range: range)
    codeView.attributedText = styled
    setNeedsLayout()
  }

  func probe(in renderer: UIView) -> InlineDiffRowProbe {
    InlineDiffRowProbe(
      row: convert(bounds, to: renderer),
      gutter: convert(gutterBand.frame, to: renderer),
      code: convert(codeBand.frame, to: renderer),
      bar: convert(bar.frame, to: renderer),
      number: convert(number.frame, to: renderer)
    )
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let row = bounds
    let gutter = min(gutterWidth, row.width)
    gutterBand.frame = CGRect(x: 0, y: 0, width: gutter, height: row.height)
    codeBand.frame = CGRect(x: gutter, y: 0, width: max(0, row.width - gutter), height: row.height)
    bar.frame = CGRect(x: 0, y: 0, width: InlineDiffMetrics.barWidth, height: row.height)
    number.frame = CGRect(
      x: InlineDiffMetrics.barWidth + 4,
      y: 0,
      width: numberWidth,
      height: row.height
    )
    pinGlyph(number, horizontal: .zero)
    codeScroll.frame = CGRect(x: gutter, y: 0, width: max(0, row.width - gutter), height: row.height)
    let text = codeView.attributedText?.string ?? " "
    let textWidth = ceil((text as NSString).size(withAttributes: InlineDiffMetrics.attributes(
      color: .label,
      alignment: .left
    )).width)
    let width = max(codeScroll.bounds.width, textWidth + InlineDiffMetrics.codeInset * 2)
    codeView.frame = CGRect(x: 0, y: 0, width: width, height: row.height)
    pinGlyph(
      codeView,
      horizontal: UIEdgeInsets(
        top: 0,
        left: InlineDiffMetrics.codeInset,
        bottom: 0,
        right: InlineDiffMetrics.codeInset
      )
    )
    codeScroll.contentSize = CGSize(width: width, height: row.height)
    codeScroll.contentOffset.y = 0
  }

  private func pinGlyph(_ view: UITextView, horizontal: UIEdgeInsets) {
    view.textContainerInset = UIEdgeInsets(
      top: InlineDiffMetrics.textInsetY,
      left: horizontal.left,
      bottom: InlineDiffMetrics.textInsetY,
      right: horizontal.right
    )
    view.contentOffset = .zero
  }

  private func voiceOver(_ line: InlineDiffLine) -> String {
    let number = line.newNumber ?? line.oldNumber ?? 0
    let kind: String
    switch line.kind {
    case .insert: kind = "added"
    case .delete: kind = "removed"
    case .context: kind = "unchanged"
    }
    return "line \(number) \(kind): \(line.text)"
  }
}

extension InlineDiffMetrics {
  @MainActor static func makeGlyphView() -> UITextView {
    let view = UITextView(usingTextLayoutManager: false)
    view.backgroundColor = .clear
    view.isEditable = false
    view.isScrollEnabled = false
    view.contentInset = .zero
    view.contentInsetAdjustmentBehavior = .never
    view.textContainer.lineFragmentPadding = 0
    view.textContainer.lineBreakMode = .byClipping
    view.textContainer.widthTracksTextView = false
    view.textContainer.heightTracksTextView = false
    view.layoutManager.usesFontLeading = false
    view.clipsToBounds = true
    return view
  }
}
