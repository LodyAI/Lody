import ChatKit
import UIKit

enum ChatRowPadding {
  static let content: CGFloat = 6
  static var durationBottom: CGFloat { content / 2 }
  /// "Worked for …" closes the user's turn: it keeps clear of the message above and sits close
  /// to the reply below. This is the room it adds above itself.
  static let durationLead: CGFloat = 12
  /// The text under it only needs the ordinary inset.
  static var textBelowDuration: CGFloat { content }
  /// The process text's distance from the row's bottom edge.
  static let durationTextBottom: CGFloat = 8

  static func top(kind: String, previousKind: String?) -> CGFloat {
    if kind == "text" && previousKind == "duration" { return textBelowDuration }
    return content
  }
}

final class ChatCollectionLayout: UICollectionViewFlowLayout {
  private var inserted: Set<IndexPath> = []

  override func invalidationContext(forBoundsChange newBounds: CGRect) -> UICollectionViewLayoutInvalidationContext {
    let context = super.invalidationContext(forBoundsChange: newBounds)
    (context as? UICollectionViewFlowLayoutInvalidationContext)?.invalidateFlowLayoutDelegateMetrics = true
    return context
  }

  override func prepare(forCollectionViewUpdates updateItems: [UICollectionViewUpdateItem]) {
    super.prepare(forCollectionViewUpdates: updateItems)
    inserted = Set(updateItems.compactMap { $0.updateAction == .insert ? $0.indexPathAfterUpdate : nil })
  }

  override func finalizeCollectionViewUpdates() {
    super.finalizeCollectionViewUpdates()
    inserted = []
  }

  // Flow layout starts inserted items at their final frame while existing rows
  // travel from their old ones. When completion folds the process above a reply,
  // new metadata would slide over the answer instead of fading in beneath it.
  override func initialLayoutAttributesForAppearingItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    let initial = super.initialLayoutAttributesForAppearingItem(at: indexPath)
    guard inserted.contains(indexPath), let attributes = initial?.copy() as? UICollectionViewLayoutAttributes else { return initial }
    var item = indexPath.item - 1
    while item >= 0, inserted.contains(IndexPath(item: item, section: indexPath.section)) { item -= 1 }
    let anchor = IndexPath(item: item, section: indexPath.section)
    guard item >= 0, let before = super.initialLayoutAttributesForAppearingItem(at: anchor),
          let after = layoutAttributesForItem(at: anchor) else { return initial }
    attributes.frame.origin.y += before.frame.minY - after.frame.minY
    return attributes
  }
}

final class ChatMetaCell: UICollectionViewCell {
  private let modelLabel = UILabel()
  let detailsButton = UIButton(type: .system)
  let actionButton = UIButton(type: .system)
  private var row: ChatRow?

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = false
    contentView.clipsToBounds = false
    modelLabel.numberOfLines = 0
    modelLabel.textAlignment = .left
    modelLabel.clipsToBounds = false
    modelLabel.adjustsFontForContentSizeCategory = true
    contentView.addSubview(modelLabel)
    contentView.addSubview(detailsButton)
    actionButton.showsMenuAsPrimaryAction = true
    actionButton.accessibilityLabel = String(localized: "native.chat.message.actions", bundle: .lody)
    contentView.addSubview(actionButton)
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitPreferredContentSizeCategory.self]) {
      (cell: ChatMetaCell, _) in
      cell.apply()
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: ChatRow) {
    self.row = row
    actionButton.accessibilityIdentifier = row.id + ":actions"
    apply()
    setNeedsLayout()
  }

  private func apply() {
    guard let row else { return }
    let font = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: traitCollection)
    let color = UIColor.secondaryLabel.resolvedColor(with: traitCollection)
    let text = Self.displayText(row, detailsEnabled: !detailsButton.isHidden)
    modelLabel.attributedText = Self.attributedText(
      text, image: Self.iconImage(named: row.imageAsset), font: font, color: color
    )
    modelLabel.isHidden = row.text.isEmpty && detailsButton.isHidden
    modelLabel.accessibilityIdentifier = row.id + ":model"
    modelLabel.accessibilityLabel = row.text
    modelLabel.isAccessibilityElement = detailsButton.isHidden
    detailsButton.accessibilityIdentifier = row.id + ":details"
    detailsButton.accessibilityLabel = [String(localized: "message.details.title", bundle: .lody), row.text].filter { !$0.isEmpty }.joined(separator: ", ")
    let symbolSize = max(1, font.pointSize - 2)
    let symbol = UIImage.SymbolConfiguration(pointSize: symbolSize, weight: .regular, scale: .small)
    let glyph = UIImage(systemName: "ellipsis", withConfiguration: symbol)
    var configuration = UIButton.Configuration.plain()
    configuration.image = glyph
    configuration.preferredSymbolConfigurationForImage = symbol
    configuration.baseForegroundColor = color
    configuration.contentInsets = NSDirectionalEdgeInsets(
      top: 0,
      leading: max(0, 44 - ceil(glyph?.size.width ?? symbolSize)),
      bottom: 0,
      trailing: 0
    )
    actionButton.configuration = configuration
    actionButton.tintColor = color
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    modelLabel.frame = CGRect(x: 0, y: 4, width: max(1, bounds.width - 52), height: bounds.height - 8)
    detailsButton.frame = CGRect(x: 0, y: 0, width: max(44, bounds.width - 52), height: max(44, bounds.height))
    actionButton.frame = CGRect(x: bounds.width - 44, y: (bounds.height - 44) / 2, width: 44, height: 44)
  }

  static func iconImage(named asset: String) -> UIImage? {
    guard !asset.isEmpty else { return nil }
    return UIImage(named: asset)?.withRenderingMode(.alwaysTemplate)
  }

  static func attributedText(
    _ text: String,
    image: UIImage?,
    font: UIFont,
    color: UIColor = .secondaryLabel
  ) -> NSAttributedString {
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
    ]
    let result = NSMutableAttributedString()
    if let image {
      let size = max(1, font.pointSize - 2)
      let drawn = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
        image.withTintColor(color, renderingMode: .alwaysOriginal)
          .draw(in: CGRect(origin: .zero, size: CGSize(width: size, height: size)))
      }
      let attachment = NSTextAttachment()
      attachment.image = drawn
      attachment.bounds = CGRect(x: 0, y: (font.capHeight - size) / 2, width: size, height: size)
      result.append(NSAttributedString(attachment: attachment))
      result.append(NSAttributedString(string: " ", attributes: attributes))
    }
    result.append(NSAttributedString(string: text, attributes: attributes))
    return result
  }

  private static func displayText(_ row: ChatRow, detailsEnabled: Bool) -> String {
    guard detailsEnabled else { return row.text }
    let text = row.text.isEmpty ? String(localized: "message.details.title", bundle: .lody) : row.text
    return text + "  ⓘ"
  }

  static func height(for row: ChatRow, width: CGFloat, traits: UITraitCollection, detailsEnabled: Bool) -> CGFloat {
    let font = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: traits)
    let text = attributedText(displayText(row, detailsEnabled: detailsEnabled), image: iconImage(named: row.imageAsset), font: font)
    let textHeight = text.boundingRect(
      with: CGSize(width: max(1, width - 52), height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      context: nil
    ).height
    return max(44, ceil(textHeight - min(0, font.descender)) + 8)
  }
}

final class ChatMarkView: UIImageView {
  private(set) var lastReplaceAnimated = false

  func setMark(_ image: UIImage?, animated: Bool) {
    lastReplaceAnimated = animated && image != nil
    if let image, animated {
      setSymbolImage(image, contentTransition: .replace.downUp)
      return
    }
    removeAllSymbolEffects(animated: false)
    self.image = image
  }

  func cancelMarkEffects() {
    lastReplaceAnimated = false
    removeAllSymbolEffects(animated: false)
  }
}

final class ChatCell: UICollectionViewCell, UIContextMenuInteractionDelegate {
  let messageContent = ChatMessageContent(frame: .zero)
  var label: CKTextView { messageContent.label }
  var numericText: ChatNumericTextHost { messageContent.numericText }
  var bubble: UIView { messageContent.bubble }
  let icon = ChatMarkView()
  let processGlyph = LodyStatusGlyphView(kind: .done)
  let processTitle = UILabel()
  let processDetail = UILabel()
  let processChevron = UIImageView()
  let processTree = CAShapeLayer()
  var row: ChatRow?
  /// A user turn's header (read mark, name · time) and the sender's avatar beside the bubble.
  private let authorMark = UIImageView()
  private let authorLabel = UILabel()
  private let authorAvatar = UIImageView()
  private var authorPhoto: URL?
  static let avatarSize: CGFloat = 36
  static let avatarSlot: CGFloat = avatarSize + 10
  static let authorHeader: CGFloat = 22
  var onInteraction: (() -> Void)?
  var canEdit: (() -> Bool)?
  var onEdit: (() -> Void)?
  func updateEditAccessibility() {
    var actions = label.linkActions
    if canEdit?() == true {
      actions.append(UIAccessibilityCustomAction(name: String(localized: "native.chat.editAction", bundle: .lody)) { [weak self] _ in
        guard self?.canEdit?() == true else { return false }
        self?.onEdit?()
        return true
      })
    }
    accessibilityCustomActions = actions
  }
  var onToggle: (() -> Void)?
  var onActivate: (() -> Void)?
  var expanded = false
  var collapsedHeight: CGFloat = ChatMessageContent.maximumCollapsedHeight
  var expandable = false
  private var markReady = false
  /// The summary's text, to place its chevron right after it.
  private var shownText = NSAttributedString()
  override init(frame: CGRect) {
    super.init(frame: frame)
    bubble.backgroundColor = .lodyUserBubble
    contentView.addSubview(messageContent)
    messageContent.disclosure.addAction(UIAction { [weak self] _ in self?.onToggle?() }, for: .touchUpInside)
    contentView.addSubview(icon)
    icon.contentMode = .center
    processTree.fillColor = nil
    processTree.lineWidth = 1
    processTree.lineCap = .round
    contentView.layer.addSublayer(processTree)
    processDetail.numberOfLines = 1
    processDetail.lineBreakMode = .byTruncatingTail
    processTitle.lineBreakMode = .byTruncatingTail
    processChevron.contentMode = .center
    processChevron.tintColor = .lodyTertiary
    processChevron.image = UIImage(
      systemName: "chevron.right",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
    )
    for view in [processGlyph, processTitle, processDetail, processChevron] as [UIView] {
      view.isAccessibilityElement = false
      view.isUserInteractionEnabled = false
      view.isHidden = true
      contentView.addSubview(view)
    }
    authorLabel.font = .dynamic(of: 13)
    authorLabel.textColor = .tertiaryLabel
    authorLabel.textAlignment = .right
    authorMark.contentMode = .scaleAspectFit
    authorAvatar.contentMode = .scaleAspectFill
    authorAvatar.clipsToBounds = true
    authorAvatar.layer.cornerRadius = Self.avatarSize / 2
    for view in [authorMark, authorLabel, authorAvatar] as [UIView] {
      view.isAccessibilityElement = false
      view.isHidden = true
      contentView.addSubview(view)
    }
    isAccessibilityElement = true
    contentView.addInteraction(UIContextMenuInteraction(delegate: self))
  }

  /// Web's user-turn header: a check once the agent picked the turn up, an open circle before.
  private func applyAuthor(_ row: ChatRow) {
    let shown = row.kind == "user" && !row.author.isEmpty
    for view in [authorMark, authorLabel, authorAvatar] as [UIView] { view.isHidden = !shown }
    accessibilityValue = nil
    guard shown else { return }
    let who = (name: row.authorName.isEmpty ? String(localized: "native.chat.member", bundle: .lody) : row.authorName, image: row.authorImage)
    // Web's order: delivery mark, time, then the sender.
    authorLabel.text = [row.authorTime, who.name].filter { !$0.isEmpty }.joined(separator: "  ")
    let marks: [String: (String, UIColor)] = [
      "seen": ("checkmark.circle", .lodyAccent), "queued": ("clock", .tertiaryLabel),
      "sending": ("circle.dotted", .tertiaryLabel), "sent": ("circle", .tertiaryLabel),
    ]
    let mark = marks[row.readState] ?? marks["sent"]!
    authorMark.image = UIImage(systemName: mark.0, withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .regular))
    authorMark.tintColor = mark.1
    let monogram = LodyListPhoto.monogram(String(who.name.prefix(1)).uppercased(), side: Self.avatarSize)
    authorPhoto = LodyListPhoto.url(who.image)
    authorAvatar.image = monogram
    if let url = authorPhoto {
      if let cached = LodyListPhoto.image(for: url, ready: { [weak self] image in
        guard let self, self.authorPhoto == url else { return }
        self.authorAvatar.image = image
      }) { authorAvatar.image = cached }
    }
    let state = String(localized: String.LocalizationValue("native.chat.read." + row.readState), bundle: .lody)
    accessibilityValue = [who.name, row.authorTime, state].filter { !$0.isEmpty }.joined(separator: ", ")
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func configure(_ row: ChatRow, text: NSAttributedString) {
    contentView.alpha = 1
    clipsToBounds = row.kind == "delivery"
    let sameRow = self.row?.id == row.id
    let previousSymbol = self.row?.symbol ?? ""
    label.setText(text, animate: row.streaming, reset: !sameRow)
    shownText = text
    self.row = row
    if row.kind == "user" { ChatSendHandoff.hold(id: row.entryID, target: messageContent) }
    else { messageContent.isHidden = false }
    bubble.isHidden = row.kind != "user"
    applyLeadingMark(for: row, previousSymbol: previousSymbol, sameRow: sameRow)
    applyProcess(row)
    applyAuthor(row)
    accessibilityIdentifier = row.id
    accessibilityLabel = row.kind == "duration"
      ? [row.text, row.detail].filter { !$0.isEmpty }.joined(separator: ", ")
      : text.string.replacingOccurrences(of: "\u{FFFC}", with: "")
    updateEditAccessibility()
    accessibilityTraits = row.actionable ? .button : .staticText
    accessibilityHint = hint(for: row)
    let process = row.kind == "summary"
    numericText.isHidden = !process
    label.isHidden = process || row.kind == "duration"
    if process {
      numericText.apply(text: text, animated: sameRow, shines: row.shines)
      label.setShine(false)
    } else {
      numericText.reset()
      label.setShine(row.shines)
    }
    setNeedsLayout()
  }
  override func accessibilityActivate() -> Bool {
    if expandable { onToggle?(); return true }
    guard row?.actionable == true else { return super.accessibilityActivate() }
    onActivate?()
    return true
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    markReady = false
    icon.cancelMarkEffects()
    label.setShine(false)
    label.isHidden = false
    numericText.reset()
    numericText.isHidden = true
    processTree.path = nil
    processChevron.transform = .identity
    label.onLink = nil
    accessibilityCustomActions = nil
  }

  private func applyProcess(_ row: ChatRow) {
    let rail = row.kind == "duration"
    processGlyph.isHidden = !rail || (!row.running && !row.attention)
    processTitle.isHidden = !rail
    processDetail.isHidden = !rail || row.detail.isEmpty
    processChevron.isHidden = !(row.actionable && (rail || row.kind == "summary"))
    icon.isHidden = rail
    guard rail else {
      processTree.path = nil
      return
    }
    // The disclosure turns down when the work is open, with the list's own motion.
    let turn = CGAffineTransform(rotationAngle: row.disclosed ? .pi / 2 : 0)
    if processChevron.transform != turn {
      if window != nil && !UIAccessibility.isReduceMotionEnabled {
        UIView.animate(withDuration: 0.28, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
          self.processChevron.transform = turn
        }
      } else {
        processChevron.transform = turn
      }
    }
    processGlyph.kind = Self.glyphKind(row)
    processTitle.attributedText = Self.processTitle(row, traits: traitCollection)
    processDetail.font = Self.detailFont(traitCollection)
    processDetail.textColor = .lodySecondary
    processDetail.text = row.detail
  }

  static func glyphKind(_ row: ChatRow) -> LodyStatusGlyph.Kind {
    if row.attention { return .attention }
    return row.running ? .live : .done
  }

  static func processTitle(_ row: ChatRow, traits: UITraitCollection) -> NSAttributedString {
    NSAttributedString(string: row.text, attributes: [
      .font: LodyDesign.mono(12, compatibleWith: traits),
      .foregroundColor: UIColor.lodySecondary,
    ])
  }

  private static func detailFont(_ traits: UITraitCollection) -> UIFont {
    LodyDesign.font(.footnote, size: 12.5, compatibleWith: traits)
  }

  private static func processLines(_ row: ChatRow, traits: UITraitCollection) -> (title: CGFloat, detail: CGFloat) {
    let font = LodyDesign.mono(12, compatibleWith: traits)
    let title = ceil(font.lineHeight)
    let detail = row.detail.isEmpty ? 0 : ceil(detailFont(traits).lineHeight) + 2
    return (title, detail)
  }

  static func processHeight(for row: ChatRow, width: CGFloat, traits: UITraitCollection) -> CGFloat {
    let lines = processLines(row, traits: traits)
    if lines.detail == 0 { return max(44, lines.title + 16) + ChatRowPadding.durationLead }
    return max(LodyDesign.Rail.primaryHeight, lines.title + lines.detail + 16) + ChatRowPadding.durationLead
  }

  private static let chevronSlot: CGFloat = 24
  private static var railCenter: CGFloat { LodyDesign.Rail.center - ChatReadingColumn.cellMargin }

  private func layoutProcess(_ row: ChatRow, width: CGFloat) {
    let height = contentView.bounds.height
    let lines = Self.processLines(row, traits: traitCollection)
    let x = processGlyph.isHidden ? 0 : LodyDesign.Rail.text - ChatReadingColumn.cellMargin
    let textWidth = max(1, width - x - (processChevron.isHidden ? 0 : Self.chevronSlot))
    // Text sits low in the row: the room above parts it from the user's message, and the reply
    // follows close below.
    let top = max(0, floor(height - lines.title - lines.detail - ChatRowPadding.durationTextBottom))
    processTitle.frame = CGRect(x: x, y: top, width: textWidth, height: lines.title)
    processDetail.frame = CGRect(x: x, y: processTitle.frame.maxY + 2, width: textWidth, height: lines.detail - 2)
    let glyph = LodyDesign.Rail.glyph
    processGlyph.frame = CGRect(x: Self.railCenter - glyph / 2, y: processTitle.frame.midY - glyph / 2, width: glyph, height: glyph)
    // The chevron follows the title ("Worked for 2m ›"), as process summaries do.
    let titleUsed = processTitle.attributedText?.boundingRect(
      with: CGSize(width: textWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil
    ).width ?? textWidth
    processChevron.frame = CGRect(x: min(width - 16, x + ceil(titleUsed) + 2), y: processTitle.frame.midY - 8, width: 16, height: 16)
    let path = UIBezierPath()
    if row.treeDown && !processGlyph.isHidden {
      path.move(to: CGPoint(x: Self.railCenter, y: processGlyph.frame.maxY + 3))
      path.addLine(to: CGPoint(x: Self.railCenter, y: height))
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    processTree.frame = contentView.bounds
    processTree.strokeColor = UIColor.lodyRail.resolvedColor(with: traitCollection).cgColor
    processTree.path = path.isEmpty ? nil : path.cgPath
    CATransaction.commit()
  }

  private func applyLeadingMark(for row: ChatRow, previousSymbol: String, sameRow: Bool) {
    let image = row.symbol.isEmpty
      ? nil
      : UIImage(systemName: row.symbol, withConfiguration: Self.iconSymbolConfiguration(for: row))
    let tint = chromeColor(for: row)
    let animated = markReady
      && sameRow
      && window != nil
      && !UIAccessibility.isReduceMotionEnabled
      && !previousSymbol.isEmpty
      && !row.symbol.isEmpty
      && previousSymbol != row.symbol
    markReady = true
    if animated, let image {
      icon.setMark(image, animated: true)
      UIView.animate(
        withDuration: 0.22,
        delay: 0,
        options: [.beginFromCurrentState, .curveEaseInOut, .allowUserInteraction]
      ) {
        self.icon.tintColor = tint
      }
      return
    }
    if !sameRow || previousSymbol != row.symbol {
      icon.setMark(image, animated: false)
    }
    icon.tintColor = tint
  }
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    guard let row, row.kind == "user" || row.kind == "text", messageContent.frame.contains(location) else { return nil }
    onInteraction?()
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in
      var actions = [UIAction(title: String(localized: "native.chat.copy", bundle: .lody), image: UIImage(systemName: "doc.on.doc")) { _ in
        UIPasteboard.general.setMessageMarkdown(row.text)
      }]
      if self.canEdit?() == true {
        let edit = self.onEdit
        actions.append(UIAction(title: String(localized: "native.chat.editAction", bundle: .lody), image: UIImage(systemName: "pencil")) { _ in edit?() })
      }
      return UIMenu(children: actions)
    }
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                             previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    contextPreview()
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                             previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    contextPreview()
  }

  private func contextPreview() -> UITargetedPreview? {
    let parameters = UIPreviewParameters()
    let bubbled = row?.kind == "user"
    parameters.backgroundColor = .clear
    parameters.visiblePath = UIBezierPath(
      roundedRect: messageContent.bounds,
      cornerRadius: bubbled ? ChatMessageContent.bubbleRadius : 8
    )
    return UITargetedPreview(view: messageContent, parameters: parameters)
  }

  static func messageFont(for row: ChatRow, compatibleWith traits: UITraitCollection) -> UIFont {
    let sizes: [String: CGFloat] = ["user": 17, "summary": 12.5]
    let font = UIFont.dynamic(of: sizes[row.kind] ?? 13, compatibleWith: traits)
    if row.kind == "duration" || row.kind == "summary" {
      return font.withTabularNumbers()
    }
    return font
  }

  /// A process summary row's height: compact, since runs of them stack between paragraphs.
  static let summaryHeight: CGFloat = 32

  static func rowExtra(for row: ChatRow, previousKind: String? = nil) -> CGFloat {
    if row.kind == "delivery" { return 0 }
    if row.kind == "user" { return 44 + (row.author.isEmpty ? 0 : authorHeader) }
    if row.kind == "duration" { return ChatRowPadding.content + ChatRowPadding.durationBottom }
    return ChatRowPadding.top(kind: row.kind, previousKind: previousKind) + ChatRowPadding.content
  }

  static func leading(_ row: ChatRow) -> CGFloat {
    switch row.kind {
    case "text", "user", "duration", "delivery": return 0
    // A process summary starts at the text edge; only a warning mark keeps the rail inset.
    case "summary": return row.symbol.isEmpty ? 0 : LodyDesign.Rail.text - ChatReadingColumn.cellMargin
    default: return 24
    }
  }
  static func iconSymbolConfiguration(for row: ChatRow) -> UIImage.SymbolConfiguration {
    if row.kind == "summary" {
      if row.attention {
        return UIImage.SymbolConfiguration(pointSize: 8, weight: .bold)
      }
      return UIImage.SymbolConfiguration(pointSize: 6)
    }
    if row.kind == "thought" {
      return UIImage.SymbolConfiguration(pointSize: 13, weight: .regular, scale: .small)
    }
    return UIImage.SymbolConfiguration(pointSize: 13)
  }
  static func iconFrame(for row: ChatRow, textY: CGFloat, textHeight: CGFloat) -> CGRect {
    if row.kind == "summary" {
      let size: CGFloat = 8
      return CGRect(x: railCenter - size / 2, y: textY + (textHeight - size) / 2, width: size, height: size)
    }
    return CGRect(x: 2, y: textY, width: 20, height: min(textHeight, 20))
  }
  static func textWidth(_ row: ChatRow, width: CGFloat) -> CGFloat {
    if row.kind == "user" { return max(1, width * 0.84 - 26 - avatarSlot) }
    if row.kind == "delivery" { return max(1, width * 0.84) }
    if row.kind == "summary" && row.actionable { return max(1, width - leading(row) - chevronSlot) }
    return max(1, width - leading(row))
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let row else { return }
    let width = contentView.bounds.width
    if row.kind == "duration" {
      isAccessibilityElement = true
      label.isAccessibilityElement = false
      expandable = false
      messageContent.expandable = false
      messageContent.disclosure.isHidden = true
      accessibilityValue = nil
      messageContent.frame = contentView.bounds
      layoutProcess(row, width: width)
      return
    }
    if row.kind == "user" {
      let size = label.sizeThatFits(CGSize(width: width * 0.84 - 26 - Self.avatarSlot, height: .greatestFiniteMagnitude))
      expandable = size.height + 20 > ChatMessageContent.maximumCollapsedHeight
      messageContent.expandable = expandable
      messageContent.expanded = expanded
      isAccessibilityElement = true
      label.isAccessibilityElement = false
      label.accessibilityLabel = row.text
      messageContent.disclosure.accessibilityIdentifier = row.id + ":collapse"
      messageContent.disclosure.isUserInteractionEnabled = expanded
      messageContent.disclosure.isAccessibilityElement = false
      accessibilityTraits = expandable ? .button : .staticText
      let disclosureKey = expanded ? "native.chat.message.collapse" : "native.chat.message.expand"
      if expandable { accessibilityValue = String(localized: String.LocalizationValue(disclosureKey), bundle: .lody) }
      let height = ChatMessageContent.height(textHeight: size.height, limit: collapsedHeight, expanded: expanded)
      let bubbleWidth = expandable ? width * 0.84 - Self.avatarSlot : size.width + 26
      // Every bubble of a turn leaves the avatar column free; the first also has the header.
      let header = row.author.isEmpty ? 0 : Self.authorHeader
      let bubbleRight = width - Self.avatarSlot
      messageContent.frame = CGRect(x: bubbleRight - bubbleWidth, y: ChatRowPadding.content + header, width: bubbleWidth, height: height)
      if !row.author.isEmpty {
        authorAvatar.frame = CGRect(x: width - Self.avatarSize, y: messageContent.frame.minY, width: Self.avatarSize, height: Self.avatarSize)
        let labelWidth = min(bubbleRight - 16, authorLabel.sizeThatFits(CGSize(width: bubbleRight, height: header)).width)
        authorLabel.frame = CGRect(x: bubbleRight - labelWidth, y: ChatRowPadding.content, width: labelWidth, height: header - 4)
        authorMark.frame = CGRect(x: authorLabel.frame.minX - 18, y: authorLabel.frame.midY - 7, width: 14, height: 14)
      }
      messageContent.setNeedsLayout()
      messageContent.layoutIfNeeded()
    } else {
      isAccessibilityElement = true
      label.isAccessibilityElement = false
      expandable = false
      messageContent.expandable = false
      messageContent.disclosure.isHidden = true
      label.layer.mask = nil
      accessibilityValue = nil
      messageContent.frame = contentView.bounds
      messageContent.layoutIfNeeded()
      let inset = Self.leading(row)
      let textWidth = Self.textWidth(row, width: width)
      let fitted = label.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude)).height
      let height: CGFloat
      if row.kind == "delivery" {
        height = max(Self.messageFont(for: row, compatibleWith: traitCollection).lineHeight, fitted)
      } else {
        height = fitted
      }
      let y: CGFloat
      if row.kind == "delivery" {
        y = 0
      } else if row.kind == "text" || row.kind == "thought" || row.kind == "duration" {
        y = ChatRowPadding.content
      } else {
        y = max(ChatRowPadding.content, (bounds.height - height) / 2)
      }
      label.frame = CGRect(x: row.kind == "delivery" ? width - textWidth : inset, y: y, width: textWidth, height: height)
      numericText.frame = label.frame
      let markHeight = row.kind == "summary"
        ? (label.lineAdvances(width: textWidth).first ?? height)
        : height
      icon.frame = Self.iconFrame(for: row, textY: y, textHeight: markHeight)
      // A process summary's chevron follows its text ("Ran 2 commands ›"), not the row's edge.
      var chevronX = width - 16
      if row.kind == "summary" {
        let used = shownText.boundingRect(
          with: CGSize(width: textWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil
        ).width
        chevronX = min(width - 16, inset + ceil(used) + 2)
      }
      processChevron.frame = CGRect(x: chevronX, y: icon.frame.midY - 8, width: 16, height: 16)
    }
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    guard previousTraitCollection?.userInterfaceStyle != traitCollection.userInterfaceStyle else { return }
    bubble.backgroundColor = .lodyUserBubble
  }
}

private func chromeColor(for row: ChatRow) -> UIColor {
  if row.kind == "chat_failed" { return .systemRed }
  // No warning orange in a conversation: a failed or waiting step says so in its own words.
  if row.attention { return .secondaryLabel }
  if row.kind == "changes" || row.kind == "file" || (row.kind == "summary" && row.running) { return .lodyAccent }
  return .secondaryLabel
}

private func hint(for row: ChatRow) -> String? {
  if row.id == row.entryID + ":pending" {
    return row.actionable ? String(localized: "native.chat.row.resend", bundle: .lody) : nil
  }
  switch row.kind {
  case "chat_failed": return String(localized: "native.chat.error.view", bundle: .lody)
  case "file": return String(localized: "native.attachment.preview.hint", bundle: .lody)
  case "duration":
    guard row.actionable else { return nil }
    if row.processStartID == "__work__" {
      return String(localized: String.LocalizationValue(row.disclosed ? "native.chat.message.collapse" : "native.chat.message.expand"), bundle: .lody)
    }
    return String(localized: "native.chat.row.openProcess", bundle: .lody)
  case "summary": return String(localized: "native.chat.row.openProcess", bundle: .lody)
  case "changes": return String(localized: "native.chat.row.openChanges", bundle: .lody)
  default: return nil
  }
}
