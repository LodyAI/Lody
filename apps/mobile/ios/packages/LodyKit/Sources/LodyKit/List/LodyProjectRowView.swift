import UIKit

struct LodyProjectRowContent: UIContentConfiguration {
  var row: LodyListRow
  var density: LodyRowDensity = .regular
  var expanded: Bool?
  var highlighted = false
  var onToggle: (@MainActor () -> Void)?

  var accessibilityLabel: String {
    [row.title, row.subtitle, row.value, row.badge].filter { !$0.isEmpty }.joined(separator: ", ")
  }

  func makeContentView() -> UIView & UIContentView { LodyProjectRowView(self) }
  func updated(for state: UIConfigurationState) -> LodyProjectRowContent {
    guard let cell = state as? UICellConfigurationState else { return self }
    var copy = self
    copy.highlighted = cell.isHighlighted
    if expanded != nil { copy.expanded = cell.isExpanded }
    return copy
  }
}

final class LodyProjectRowView: UIView, UIContentView {
  private let glyph = LodyStatusGlyphView(kind: .project)
  private let symbol = UIImageView()
  private let avatar = UIImageView()
  private var avatarURL: URL?
  private let name = UILabel()
  private let detail = UILabel()
  private let count = UILabel()
  private let fold = UIImageView()
  private var glyphCenter: NSLayoutConstraint!
  private var detailAfterName: NSLayoutConstraint!
  private var withFold: [NSLayoutConstraint] = []

  var configuration: UIContentConfiguration {
    didSet { apply() }
  }

  init(_ configuration: LodyProjectRowContent) {
    self.configuration = configuration
    super.init(frame: .zero)
    insetsLayoutMarginsFromSafeArea = false
    preservesSuperviewLayoutMargins = false
    symbol.tintColor = .lodySecondary
    symbol.contentMode = .center
    avatar.accessibilityIdentifier = "project-avatar"
    avatar.contentMode = .scaleAspectFill
    avatar.clipsToBounds = true
    avatar.layer.cornerRadius = 4.5
    avatar.layer.cornerCurve = .continuous
    avatar.layer.borderWidth = 0.5
    layer.cornerCurve = .continuous
    fold.tintColor = .lodyTertiary
    fold.contentMode = .center
    fold.setContentCompressionResistancePriority(.required, for: .horizontal)
    name.adjustsFontForContentSizeCategory = true
    name.textColor = .lodyInk
    detail.adjustsFontForContentSizeCategory = true
    count.adjustsFontForContentSizeCategory = true
    count.textAlignment = .right
    for label in [name, detail, count] {
      label.lineBreakMode = .byTruncatingTail
    }
    detail.lineBreakMode = .byTruncatingMiddle
    detail.textColor = .lodyTertiary
    name.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
    detail.setContentCompressionResistancePriority(.defaultLow - 1, for: .horizontal)
    count.setContentCompressionResistancePriority(.required, for: .horizontal)
    count.setContentHuggingPriority(.required, for: .horizontal)
    for view in [glyph, symbol, avatar, name, detail, count, fold] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    let margin = layoutMarginsGuide
    glyphCenter = glyph.centerXAnchor.constraint(equalTo: leadingAnchor)
    detailAfterName = detail.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 8)
    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: 44),
      glyphCenter,
      glyph.widthAnchor.constraint(equalToConstant: LodyDesign.Rail.glyph),
      glyph.heightAnchor.constraint(equalToConstant: LodyDesign.Rail.glyph),
      glyph.centerYAnchor.constraint(equalTo: name.centerYAnchor),
      symbol.centerXAnchor.constraint(equalTo: glyph.centerXAnchor),
      symbol.centerYAnchor.constraint(equalTo: glyph.centerYAnchor),
      avatar.centerXAnchor.constraint(equalTo: glyph.centerXAnchor),
      avatar.centerYAnchor.constraint(equalTo: glyph.centerYAnchor),
      avatar.widthAnchor.constraint(equalToConstant: 18),
      avatar.heightAnchor.constraint(equalToConstant: 18),
      name.centerYAnchor.constraint(equalTo: centerYAnchor),
      name.leadingAnchor.constraint(equalTo: margin.leadingAnchor),
      name.trailingAnchor.constraint(lessThanOrEqualTo: count.leadingAnchor, constant: -10),
      detail.centerYAnchor.constraint(equalTo: name.centerYAnchor),
      detail.trailingAnchor.constraint(lessThanOrEqualTo: count.leadingAnchor, constant: -10),
      count.trailingAnchor.constraint(equalTo: margin.trailingAnchor),
      count.centerYAnchor.constraint(equalTo: name.centerYAnchor),
    ])
    withFold = [
      fold.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 5),
      fold.centerYAnchor.constraint(equalTo: name.centerYAnchor),
      detail.leadingAnchor.constraint(equalTo: fold.trailingAnchor, constant: 8),
    ]
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self], action: #selector(resolveAvatarBorder))
    resolveAvatarBorder()
    apply()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  private func apply() {
    guard let content = configuration as? LodyProjectRowContent else { return }
    let row = content.row
    let compact = content.density == .compact
    directionalLayoutMargins = .init(
      top: 0,
      leading: compact ? LodyDesign.Rail.compactText : LodyDesign.Rail.text,
      bottom: 0,
      trailing: compact ? 10 : LodyDesign.Rail.trailing
    )
    backgroundColor = content.highlighted ? .lodyBandPressed : .lodyBand
    layer.cornerRadius = compact ? 10 : 0
    glyphCenter.constant = compact ? LodyDesign.Rail.compactCenter : LodyDesign.Rail.center
    let url = LodyListPhoto.url(row.image)
    let image = url == nil && !row.image.isEmpty ? UIImage(systemName: row.image) : nil
    symbol.image = image
    symbol.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 12, weight: .medium)
    symbol.isHidden = image == nil
    avatarURL = url
    showAvatar(url.flatMap { source in
      LodyListPhoto.image(for: source, shape: .original, ready: { [weak self] photo in
        guard let self, self.avatarURL == source else { return }
        self.showAvatar(photo)
      })
    }, symbol: image != nil)
    let nameFont = LodyDesign.font(.subheadline, size: compact ? 14 : 15, weight: .semibold)
    let nameText = NSMutableAttributedString(string: row.title, attributes: [.font: nameFont, .foregroundColor: UIColor.lodyInk])
    LodySessionRowView.emphasize(nameText, in: NSRange(location: 0, length: nameText.length), query: row.highlight)
    name.font = nameFont
    name.attributedText = nameText
    detail.font = LodyDesign.mono(compact ? 10.5 : 11)
    detail.text = row.subtitle
    detail.isHidden = row.subtitle.isEmpty
    count.font = LodyDesign.mono(compact ? 11 : 11.5)
    count.text = row.badge.isEmpty ? row.value : row.badge
    count.textColor = row.badge.isEmpty && row.imageTint == "warning" ? .lodyAttention : .lodySecondary
    count.isHidden = count.text?.isEmpty ?? true
    applyFold(content)
    isAccessibilityElement = true
    accessibilityLabel = content.accessibilityLabel
  }

  private func showAvatar(_ photo: UIImage?, symbol: Bool = false) {
    avatar.image = photo
    avatar.isHidden = photo == nil
    glyph.isHidden = photo != nil || symbol
  }

  @objc private func resolveAvatarBorder() {
    avatar.layer.borderColor = UIColor.separator.resolvedColor(with: traitCollection).cgColor
  }

  private func applyFold(_ content: LodyProjectRowContent) {
    guard let expanded = content.expanded else {
      fold.isHidden = true
      NSLayoutConstraint.deactivate(withFold)
      detailAfterName.isActive = true
      accessibilityValue = nil
      accessibilityCustomActions = nil
      return
    }
    let symbol = expanded ? "chevron.down" : "chevron.right"
    fold.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .heavy))
    fold.isHidden = false
    detailAfterName.isActive = false
    NSLayoutConstraint.activate(withFold)
    accessibilityValue = String(localized: String.LocalizationValue(expanded ? "native.list.expanded" : "native.list.collapsed"), bundle: .lody)
    let toggle = String(localized: String.LocalizationValue(expanded ? "native.list.collapse" : "native.list.expand"), bundle: .lody)
    accessibilityCustomActions = content.onToggle.map { onToggle in
      [UIAccessibilityCustomAction(name: toggle) { _ in
        onToggle()
        return true
      }]
    }
  }
}
