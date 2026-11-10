import UIKit

struct LodySessionRowContent: UIContentConfiguration {
  var row: LodyListRow
  var density: LodyRowDensity = .regular
  var treeDown = false
  var expanded = true
  var onReview: (@MainActor () -> Void)?
  var onToggle: (@MainActor () -> Void)?

  @MainActor var accessibilityLabel: String {
    [row.title, row.badge, LodySessionRowView.meta(for: row).string, row.accessibilityValue.isEmpty ? row.value : row.accessibilityValue]
      .filter { !$0.isEmpty }.joined(separator: ", ")
  }

  @MainActor var showsChildren: Bool {
    onToggle != nil && !row.collapsedValue.isEmpty && row.parentId.isEmpty
  }

  @MainActor var showsReview: Bool {
    density == .regular && onReview != nil && LodyStatusGlyph.kind(for: row) == .attention
  }

  func makeContentView() -> UIView & UIContentView { LodySessionRowView(self) }
  func updated(for state: UIConfigurationState) -> LodySessionRowContent {
    guard onToggle != nil, let cell = state as? UICellConfigurationState else { return self }
    var copy = self
    copy.expanded = cell.isExpanded
    return copy
  }
}

final class LodyIndentedCell: UICollectionViewListCell {
  private var separatorLeading: NSLayoutConstraint!

  var textLeading: CGFloat = LodyDesign.Rail.text {
    didSet { separatorLeading.constant = textLeading }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    separatorLeading = separatorLayoutGuide.leadingAnchor.constraint(
      equalTo: contentView.leadingAnchor, constant: textLeading
    )
    separatorLeading.isActive = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }
}

private final class LodyHitButton: UIButton {
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let grow = max(0, 44 - bounds.height) / 2
    return bounds.insetBy(dx: -max(0, 44 - bounds.width) / 2, dy: -grow).contains(point)
  }
}

final class LodySessionRowView: UIView, UIContentView {
  private let glyph = LodyStatusGlyphView(kind: .none)
  private let tree = CAShapeLayer()
  private let meta = UILabel()
  private let time = UILabel()
  private let title = UILabel()
  private let review = LodyHitButton(type: .system)
  private let children = LodyHitButton(type: .system)
  private var withMeta: [NSLayoutConstraint] = []
  private var withoutMeta: [NSLayoutConstraint] = []
  private var withReview: [NSLayoutConstraint] = []
  private var withChildren: [NSLayoutConstraint] = []
  private var glyphCenter: NSLayoutConstraint!
  private var minimumHeight: NSLayoutConstraint!

  var configuration: UIContentConfiguration {
    didSet { apply() }
  }

  init(_ configuration: LodySessionRowContent) {
    self.configuration = configuration
    super.init(frame: .zero)
    insetsLayoutMarginsFromSafeArea = false
    preservesSuperviewLayoutMargins = false
    tree.fillColor = nil
    tree.lineWidth = 1
    tree.lineCap = .round
    layer.addSublayer(tree)
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (view: Self, _) in
      view.setNeedsLayout()
    }
    title.adjustsFontForContentSizeCategory = true
    meta.adjustsFontForContentSizeCategory = true
    time.adjustsFontForContentSizeCategory = true
    time.textColor = .lodyTertiary
    time.textAlignment = .right
    for label in [title, meta, time] {
      label.lineBreakMode = .byTruncatingTail
    }
    title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    meta.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    time.setContentCompressionResistancePriority(.required, for: .horizontal)
    time.setContentHuggingPriority(.required, for: .horizontal)
    var capsule = UIButton.Configuration.plain()
    capsule.cornerStyle = .capsule
    capsule.background.backgroundColor = .clear
    capsule.background.strokeColor = .lodyLine2
    capsule.background.strokeWidth = 1
    capsule.baseForegroundColor = .lodyInk
    capsule.contentInsets = .init(top: 0, leading: 11, bottom: 0, trailing: 11)
    capsule.title = String(localized: "inbox.review", bundle: .lody)
    capsule.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var attributes = attributes
      attributes.font = LodyDesign.font(.subheadline, size: 13, weight: .semibold)
      return attributes
    }
    review.configuration = capsule
    review.setContentCompressionResistancePriority(.required, for: .horizontal)
    review.addTarget(self, action: #selector(reviewTapped), for: .primaryActionTriggered)
    var fold = UIButton.Configuration.plain()
    fold.contentInsets = .zero
    fold.imagePlacement = .trailing
    fold.imagePadding = 4
    children.configuration = fold
    children.setContentCompressionResistancePriority(.required, for: .horizontal)
    children.setContentHuggingPriority(.required, for: .horizontal)
    children.addTarget(self, action: #selector(childrenTapped), for: .primaryActionTriggered)
    for view in [glyph, meta, time, title, review, children] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    let margin = layoutMarginsGuide
    minimumHeight = heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
    glyphCenter = glyph.centerXAnchor.constraint(equalTo: leadingAnchor)
    NSLayoutConstraint.activate([
      glyphCenter,
      glyph.widthAnchor.constraint(equalToConstant: LodyDesign.Rail.glyph),
      glyph.heightAnchor.constraint(equalToConstant: LodyDesign.Rail.glyph),
      glyph.centerYAnchor.constraint(equalTo: title.centerYAnchor),
      title.topAnchor.constraint(equalTo: margin.topAnchor),
      title.leadingAnchor.constraint(equalTo: margin.leadingAnchor),
      title.trailingAnchor.constraint(lessThanOrEqualTo: time.leadingAnchor, constant: -10),
      time.trailingAnchor.constraint(equalTo: margin.trailingAnchor),
      time.firstBaselineAnchor.constraint(equalTo: title.firstBaselineAnchor),
      review.heightAnchor.constraint(equalToConstant: 26),
      review.trailingAnchor.constraint(equalTo: margin.trailingAnchor),
    ])
    withMeta = [
      meta.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 2),
      meta.leadingAnchor.constraint(equalTo: margin.leadingAnchor),
      meta.trailingAnchor.constraint(lessThanOrEqualTo: margin.trailingAnchor),
      meta.bottomAnchor.constraint(lessThanOrEqualTo: margin.bottomAnchor),
      meta.bottomAnchor.constraint(equalTo: margin.bottomAnchor).withPriority(.defaultHigh),
    ]
    withoutMeta = [
      title.bottomAnchor.constraint(lessThanOrEqualTo: margin.bottomAnchor),
      title.centerYAnchor.constraint(equalTo: centerYAnchor).withPriority(.defaultHigh),
    ]
    withReview = [
      review.centerYAnchor.constraint(equalTo: centerYAnchor),
      title.trailingAnchor.constraint(lessThanOrEqualTo: review.leadingAnchor, constant: -8),
      meta.trailingAnchor.constraint(lessThanOrEqualTo: review.leadingAnchor, constant: -8),
      children.trailingAnchor.constraint(lessThanOrEqualTo: review.leadingAnchor, constant: -8),
    ]
    withChildren = [
      children.leadingAnchor.constraint(equalTo: meta.trailingAnchor),
      children.centerYAnchor.constraint(equalTo: meta.centerYAnchor),
      children.trailingAnchor.constraint(lessThanOrEqualTo: margin.trailingAnchor),
    ]
    apply()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override func systemLayoutSizeFitting(
    _ targetSize: CGSize,
    withHorizontalFittingPriority horizontalFittingPriority: UILayoutPriority,
    verticalFittingPriority: UILayoutPriority
  ) -> CGSize {
    // List self-sizing requests may carry an expanded height during an outline
    // update. This content's height is determined by its labels, not that proposal.
    super.systemLayoutSizeFitting(
      CGSize(width: targetSize.width, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: horizontalFittingPriority,
      verticalFittingPriority: .fittingSizeLevel
    )
  }

  static func textLeading(for row: LodyListRow, density: LodyRowDensity) -> CGFloat {
    let child = !row.parentId.isEmpty
    if density == .compact {
      return child ? LodyDesign.Rail.compactChildText : LodyDesign.Rail.compactText
    }
    return child ? LodyDesign.Rail.childText : LodyDesign.Rail.text
  }

  static func glyphCenter(for row: LodyListRow, density: LodyRowDensity) -> CGFloat {
    let child = !row.parentId.isEmpty
    if density == .compact {
      return child ? LodyDesign.Rail.compactChildCenter : LodyDesign.Rail.compactCenter
    }
    return child ? LodyDesign.Rail.childCenter : LodyDesign.Rail.center
  }

  static func trunk(for density: LodyRowDensity) -> CGFloat {
    density == .compact ? LodyDesign.Rail.compactCenter : LodyDesign.Rail.center
  }

  @objc private func reviewTapped() {
    (configuration as? LodySessionRowContent)?.onReview?()
  }

  @objc private func childrenTapped() {
    (configuration as? LodySessionRowContent)?.onToggle?()
  }

  private func apply() {
    guard let content = configuration as? LodySessionRowContent else { return }
    let row = content.row
    let child = !row.parentId.isEmpty
    let kind = LodyStatusGlyph.kind(for: row)
    let compact = content.density == .compact
    var vertical: CGFloat = child ? 11 : 8
    if compact { vertical = 5 }
    let trailing = compact ? 10 : LodyDesign.Rail.trailing
    directionalLayoutMargins = .init(
      top: vertical, leading: Self.textLeading(for: row, density: content.density), bottom: vertical, trailing: trailing
    )
    minimumHeight.isActive = content.density == .compact || !child
    glyphCenter.constant = Self.glyphCenter(for: row, density: content.density)
    glyph.kind = kind
    let size: CGFloat = (child ? 14 : 15) - (compact ? 1 : 0)
    let titleFont = LodyDesign.font(.subheadline, size: size, weight: row.unread && !child ? .semibold : .regular)
    let titleColor: UIColor = row.destructive ? .systemRed : .lodyInk
    let titleText = NSMutableAttributedString(string: row.title, attributes: [.font: titleFont, .foregroundColor: titleColor])
    if child, !row.modelName.isEmpty {
      titleText.append(NSAttributedString(
        string: " · " + row.modelName,
        attributes: [.font: Self.fonts(content.density).body, .foregroundColor: UIColor.lodySecondary]
      ))
    }
    Self.emphasize(titleText, in: NSRange(location: 0, length: (row.title as NSString).length), query: row.highlight)
    title.font = titleFont
    title.attributedText = titleText
    let showsReview = content.showsReview
    time.font = Self.fonts(content.density).mono
    time.text = row.value
    time.isHidden = showsReview
    var metaRow = row
    if showsReview { metaRow.modelName = [row.modelName, row.value].filter { !$0.isEmpty }.joined(separator: " · ") }
    let metaText = NSMutableAttributedString(attributedString: child ? NSAttributedString() : Self.meta(for: metaRow, density: content.density))
    let showsChildren = content.showsChildren
    if showsChildren, metaText.length > 0 {
      metaText.append(NSAttributedString(string: " · ", attributes: [.font: Self.fonts(content.density).body, .foregroundColor: UIColor.lodyTertiary]))
    }
    meta.attributedText = metaText
    meta.numberOfLines = row.wrapSubtitle && !compact ? 2 : 1
    applyChildren(content)
    let hasMeta = metaText.length > 0 || showsChildren
    meta.isHidden = !hasMeta
    NSLayoutConstraint.deactivate(hasMeta ? withoutMeta : withMeta)
    NSLayoutConstraint.activate(hasMeta ? withMeta : withoutMeta)
    review.isHidden = !showsReview
    if showsReview {
      NSLayoutConstraint.activate(withReview)
    } else {
      NSLayoutConstraint.deactivate(withReview)
    }
    isAccessibilityElement = true
    accessibilityLabel = [content.accessibilityLabel, showsChildren ? row.collapsedValue : ""].filter { !$0.isEmpty }.joined(separator: ", ")
    accessibilityValue = showsChildren
      ? String(localized: String.LocalizationValue(content.expanded ? "native.list.expanded" : "native.list.collapsed"), bundle: .lody)
      : nil
    var actions: [UIAccessibilityCustomAction] = []
    if showsReview {
      actions.append(UIAccessibilityCustomAction(name: String(localized: "inbox.review", bundle: .lody)) { [weak self] _ in
        self?.reviewTapped()
        return true
      })
    }
    if showsChildren {
      let name = String(localized: String.LocalizationValue(content.expanded ? "native.list.collapse" : "native.list.expand"), bundle: .lody)
      actions.append(UIAccessibilityCustomAction(name: name) { [weak self] _ in
        self?.childrenTapped()
        return true
      })
    }
    accessibilityCustomActions = actions.isEmpty ? nil : actions
    setNeedsLayout()
  }

  private func applyChildren(_ content: LodySessionRowContent) {
    children.isHidden = !content.showsChildren
    guard content.showsChildren else {
      NSLayoutConstraint.deactivate(withChildren)
      return
    }
    var fold = children.configuration ?? .plain()
    fold.attributedTitle = AttributedString(content.row.collapsedValue, attributes: AttributeContainer([
      .font: Self.fonts(content.density).body, .foregroundColor: UIColor.lodySecondary,
    ]))
    fold.image = UIImage(
      systemName: content.expanded ? "chevron.down" : "chevron.right",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .bold)
    )?.withTintColor(.lodyTertiary, renderingMode: .alwaysOriginal)
    children.configuration = fold
    NSLayoutConstraint.activate(withChildren)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let content = configuration as? LodySessionRowContent else { return }
    let row = content.row
    let x = Self.trunk(for: content.density)
    let mark = glyph.frame
    let path = UIBezierPath()
    if !row.parentId.isEmpty {
      let radius: CGFloat = 7
      let turn = mark.midY
      path.move(to: CGPoint(x: x, y: 0))
      path.addLine(to: CGPoint(x: x, y: turn - radius))
      path.addQuadCurve(to: CGPoint(x: x + radius, y: turn), controlPoint: CGPoint(x: x, y: turn))
      path.addLine(to: CGPoint(x: mark.minX - 1, y: turn))
      if !row.lastChild {
        path.move(to: CGPoint(x: x, y: turn - radius))
        path.addLine(to: CGPoint(x: x, y: bounds.height))
      }
    } else if content.treeDown {
      path.move(to: CGPoint(x: x, y: mark.maxY + 3))
      path.addLine(to: CGPoint(x: x, y: bounds.height))
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    tree.frame = bounds
    tree.strokeColor = UIColor.lodyRail.resolvedColor(with: traitCollection).cgColor
    tree.path = path.isEmpty ? nil : path.cgPath
    tree.isHidden = path.isEmpty
    CATransaction.commit()
  }

  private static func fonts(_ density: LodyRowDensity) -> (body: UIFont, mono: UIFont) {
    density == .compact
      ? (LodyDesign.font(.footnote, size: 12), LodyDesign.mono(11))
      : (LodyDesign.font(.footnote, size: 12.5), LodyDesign.mono(11.5))
  }

  static func meta(for row: LodyListRow, density: LodyRowDensity = .regular) -> NSAttributedString {
    let body = fonts(density).body
    let text = NSMutableAttributedString()
    if row.pinned, let pin = UIImage(systemName: "pin.fill") {
      let attachment = NSTextAttachment()
      attachment.image = pin.withTintColor(.lodySecondary, renderingMode: .alwaysOriginal)
      let side = body.capHeight
      attachment.bounds = CGRect(x: 0, y: 0, width: side, height: side)
      text.append(NSAttributedString(attachment: attachment))
      text.append(NSAttributedString(string: " ", attributes: [.font: body]))
    }
    let separator = NSAttributedString(string: " · ", attributes: [.font: body, .foregroundColor: UIColor.lodyTertiary])
    if !row.subtitle.isEmpty {
      let start = text.length
      text.append(NSAttributedString(
        string: row.subtitle,
        attributes: [.font: body, .foregroundColor: UIColor.lodySecondary]
      ))
      emphasize(text, in: NSRange(location: start, length: text.length - start), query: row.highlight)
    }
    if !row.modelName.isEmpty {
      if !row.subtitle.isEmpty { text.append(separator) }
      text.append(NSAttributedString(string: row.modelName, attributes: [.font: body, .foregroundColor: UIColor.lodySecondary]))
    }
    let add = row.diff["add"] ?? 0, del = row.diff["del"] ?? 0
    if row.badge.isEmpty, add > 0 || del > 0 {
      let digits = UIFont.monospacedDigitSystemFont(ofSize: body.pointSize, weight: .regular)
      if !row.subtitle.isEmpty || !row.modelName.isEmpty { text.append(separator) }
      text.append(NSAttributedString(string: "+\(add) −\(del)", attributes: [.font: digits, .foregroundColor: UIColor.lodySecondary]))
    }
    return text
  }
}

extension LodySessionRowView {
  static func emphasize(_ text: NSMutableAttributedString, in scope: NSRange, query: String) {
    guard !query.isEmpty, scope.length > 0 else { return }
    let part = (text.string as NSString).substring(with: scope)
    for match in TextSearch.ranges(in: part, query: query) {
      let range = NSRange(location: scope.location + match.location, length: match.length)
      let font = text.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont
      if let font {
        let weight = (font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat ?? 0
        text.addAttribute(.font, value: font.withWeight(weight >= UIFont.Weight.semibold.rawValue ? .bold : .semibold), range: range)
      }
      text.addAttribute(.foregroundColor, value: UIColor.lodyInk, range: range)
    }
  }
}

private extension NSLayoutConstraint {
  func withPriority(_ priority: UILayoutPriority) -> NSLayoutConstraint {
    self.priority = priority
    return self
  }
}

extension UIFont {
  func withWeight(_ weight: UIFont.Weight) -> UIFont {
    let traits = fontDescriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]])
    return UIFont(descriptor: traits, size: pointSize)
  }
}
