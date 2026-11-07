import UIKit

private final class ChatAttachmentAccessibilityElement: UIAccessibilityElement {
  var activate: (() -> Void)?
  override func accessibilityActivate() -> Bool {
    guard let activate else { return false }
    activate()
    return true
  }
}

/// One stable attachment grid for local sends and authoritative history.
final class ChatMessageAttachmentsCell: UICollectionViewCell, UIContextMenuInteractionDelegate {
  var canEdit: (() -> Bool)?
  var onEdit: (() -> Void)?
  func updateEditAccessibility() {
    for tile in accessibleTiles {
      tile.accessibilityCustomActions = canEdit?() == true ? [UIAccessibilityCustomAction(name: String(localized: "native.chat.editAction", bundle: .lody)) { [weak self] _ in
        guard self?.canEdit?() == true else { return false }
        self?.onEdit?()
        return true
      }] : []
    }
  }
  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    guard canEdit?() == true else { return nil }
    let edit = onEdit
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in
      UIMenu(children: [UIAction(title: String(localized: "native.chat.editAction", bundle: .lody), image: UIImage(systemName: "pencil")) { _ in edit?() }])
    }
  }
  static let tileHeight: CGFloat = 76
  static let gap: CGFloat = 8
  private var tiles: [UIView] = []
  private var loadingBadges: [UIVisualEffectView] = []
  private var accessibleTiles: [ChatAttachmentAccessibilityElement] = []
  private lazy var accessibleToggle = ChatAttachmentAccessibilityElement(accessibilityContainer: contentView)
  private var rendered: [ChatMessageAttachment] = []
  private var overflowFlightID: String?
  private var displayedCount = 0
  private var entryID = ""
  private var workspace = ""
  private var session = ""
  var expanded = false
  var onToggle: (() -> Void)?
  var onPreview: ((ChatMessageAttachment, ChatImageCell?) -> Void)?
  private let toggle = UIButton(type: .system)

  static func columns(width: CGFloat) -> Int { max(1, Int((width * 0.84 + gap) / (92 + gap))) }
  static func height(count: Int, width: CGFloat, expanded: Bool) -> CGFloat {
    let columns = columns(width: width)
    let lines = expanded ? (count + columns - 1) / columns : 1
    return CGFloat(lines) * (tileHeight + gap) + (expanded && count > columns ? 44 : 0) + 4
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addInteraction(UIContextMenuInteraction(delegate: self))
    isAccessibilityElement = false
    contentView.isAccessibilityElement = false
    toggle.titleLabel?.font = .preferredFont(forTextStyle: .subheadline)
    toggle.backgroundColor = .secondarySystemBackground
    toggle.layer.cornerRadius = 12
    toggle.addAction(UIAction { [weak self] _ in self?.onToggle?() }, for: .touchUpInside)
    contentView.addSubview(toggle)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: ChatRow, workspace: String, session: String, expanded: Bool) {
    let contextChanged = self.workspace != workspace || self.session != session
    if entryID != row.entryID { overflowFlightID = nil }
    entryID = row.entryID
    self.workspace = workspace
    self.session = session
    self.expanded = expanded
    accessibilityIdentifier = row.id
    // Keep image loaders alive across status updates and local-to-server reconciliation.
    if rendered != row.attachments || contextChanged {
      tiles.forEach { $0.removeFromSuperview() }
      tiles = row.attachments.map { attachment in
        let tile: UIView
        if let image = attachment.image {
          let cell = ChatImageCell()
          cell.compact = true
          cell.configure(ChatRow(id: row.entryID + ":attachment:" + (attachment.localID ?? attachment.id),
            entryID: row.entryID, kind: "image", text: attachment.fileName,
            localImageURI: attachment.localURI, image: image), workspace: workspace, session: session)
          cell.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openImage(_:))))
          tile = cell
        } else {
          var config = UIButton.Configuration.plain()
          config.image = MaterialFileIcon.image(for: attachment.fileName)
          config.imagePlacement = .top
          config.imagePadding = 6
          config.title = attachment.fileName
          config.titleLineBreakMode = .byTruncatingMiddle
          config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var result = incoming
            result.font = .preferredFont(forTextStyle: .caption1)
            return result
          }
          config.baseForegroundColor = .label
          let button = UIButton(configuration: config)
          button.accessibilityTraits = .button
          button.backgroundColor = .secondarySystemBackground
          button.layer.cornerRadius = 12
          button.addAction(UIAction { [weak self] _ in self?.onPreview?(attachment, nil) }, for: .touchUpInside)
          tile = button
        }
        tile.accessibilityIdentifier = row.entryID + ":attachment:" + (attachment.localID ?? attachment.id)
        let key = attachment.image == nil ? "native.chat.attachment.preview" : "native.chat.image.label"
        tile.accessibilityLabel = String.localizedStringWithFormat(String(localized: String.LocalizationValue(key), bundle: .lody), String(describing: attachment.fileName))
        contentView.addSubview(tile)
        return tile
      }
      rendered = row.attachments
      loadingBadges = tiles.map { tile in
        let badge = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
        badge.isUserInteractionEnabled = false
        badge.layer.cornerRadius = 16
        badge.clipsToBounds = true
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.frame = CGRect(x: 14, y: 6, width: 20, height: 20)
        badge.contentView.addSubview(spinner)
        let percent = UILabel(frame: CGRect(x: 0, y: 0, width: 48, height: 32))
        percent.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        percent.textColor = .label
        percent.textAlignment = .center
        badge.contentView.addSubview(percent)
        tile.addSubview(badge)
        return badge
      }
      // Visual flight masks must not remove controls from the accessibility tree.
      accessibleTiles = tiles.enumerated().map { index, tile in
        let element = ChatAttachmentAccessibilityElement(accessibilityContainer: contentView)
        element.accessibilityIdentifier = tile.accessibilityIdentifier
        element.accessibilityLabel = tile.accessibilityLabel
        element.accessibilityTraits = tile.accessibilityTraits
        let attachment = row.attachments[index]
        element.activate = { [weak self, weak tile] in self?.onPreview?(attachment, tile as? ChatImageCell) }
        return element
      }
    }
    for (index, badge) in loadingBadges.enumerated() {
      let attachment = rendered[index]
      let progress = row.uploadProgress[attachment.localID ?? attachment.id]
      let loading = row.running && progress?.phase != "complete"
      let percent = progress?.phase == "uploading" ? progress?.percent : nil
      badge.isHidden = !loading
      let spinner = badge.contentView.subviews.first as? UIActivityIndicatorView
      let label = badge.contentView.subviews.last as? UILabel
      label?.text = percent.map { "\(min(100, max(0, $0)))%" }
      label?.isHidden = percent == nil
      if loading && percent == nil { spinner?.startAnimating() } else { spinner?.stopAnimating() }
      var status = row.text
      if let percent {
        status = String.localizedStringWithFormat(String(localized: "native.chat.attachment.uploadProgress", bundle: .lody), String(describing: min(100, max(0, percent))))
      } else if progress?.phase == "preparing" {
        status = String(localized: "native.chat.attachment.preparing", bundle: .lody)
      } else if progress?.phase == "verifying" {
        status = String(localized: "native.chat.attachment.verifying", bundle: .lody)
      }
      accessibleTiles[index].accessibilityValue = loading ? status : nil
    }
    contentView.bringSubviewToFront(toggle)
    setNeedsLayout()
  }

  func imageCell(id: String) -> ChatImageCell? {
    tiles.compactMap { $0 as? ChatImageCell }.first { $0.accessibilityIdentifier == id }
  }

  @objc private func openImage(_ recognizer: UITapGestureRecognizer) {
    guard let cell = recognizer.view as? ChatImageCell, let index = tiles.firstIndex(where: { $0 === cell }) else { return }
    onPreview?(rendered[index], cell)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let width = contentView.bounds.width
    let columns = Self.columns(width: width)
    let overflow = rendered.count > columns
    let count = expanded || !overflow ? rendered.count : max(0, columns - 1)
    displayedCount = count
    let tileWidth = (width * 0.84 - CGFloat(columns - 1) * Self.gap) / CGFloat(columns)
    let usedColumns = min(columns, rendered.count)
    let leading = width - CGFloat(usedColumns) * (tileWidth + Self.gap) + Self.gap
    for (index, tile) in tiles.enumerated() {
      tile.isHidden = index >= count
      tile.frame = CGRect(x: leading + CGFloat(index % columns) * (tileWidth + Self.gap),
        y: 6 + CGFloat(index / columns) * (Self.tileHeight + Self.gap), width: tileWidth, height: Self.tileHeight)
      tile.layoutIfNeeded()
      loadingBadges[index].frame = CGRect(x: (tile.bounds.width - 48) / 2,
        y: rendered[index].image == nil ? 6 : (tile.bounds.height - 32) / 2, width: 48, height: 32)
      accessibleTiles[index].accessibilityFrameInContainerSpace = tile.frame
      if index < count { ChatSendHandoff.hold(id: entryID + ":attachment:" + (rendered[index].localID ?? rendered[index].id), target: tile, visualOnly: true) }
    }
    toggle.isHidden = !overflow
    toggle.accessibilityIdentifier = entryID + ":attachments-toggle"
    if let overflowFlightID, overflow { ChatSendHandoff.hold(id: overflowFlightID, target: toggle, visualOnly: true) }
    if expanded {
      toggle.setTitle(String(localized: "native.chat.message.collapse", bundle: .lody), for: .normal)
      toggle.accessibilityLabel = String(localized: "native.chat.attachments.collapse", bundle: .lody)
      toggle.frame = CGRect(x: width * 0.16, y: bounds.height - 44, width: width * 0.84, height: 44)
    } else {
      let hidden = rendered.count - count
      toggle.setTitle("+\(hidden)", for: .normal)
      toggle.accessibilityLabel = String.localizedStringWithFormat(String(localized: "native.chat.attachments.expand", bundle: .lody), String(describing: String(hidden)))
      toggle.frame = CGRect(x: leading + CGFloat(columns - 1) * (tileWidth + Self.gap), y: 6, width: tileWidth, height: Self.tileHeight)
    }
    accessibleToggle.accessibilityIdentifier = toggle.accessibilityIdentifier
    accessibleToggle.accessibilityLabel = toggle.accessibilityLabel
    accessibleToggle.accessibilityTraits = .button
    accessibleToggle.accessibilityFrameInContainerSpace = toggle.frame
    accessibleToggle.activate = { [weak self] in self?.onToggle?() }
    var accessible = Array(accessibleTiles.prefix(count))
    if overflow { accessible.append(accessibleToggle) }
    contentView.accessibilityElements = accessible
    updateEditAccessibility()
  }

  func deliverPendingAttachments(scrollDistance: CGFloat) {
    for (index, tile) in tiles.enumerated() {
      let key = entryID + ":attachment:" + (rendered[index].localID ?? rendered[index].id)
      if index >= displayedCount {
        if overflowFlightID == nil && ChatSendHandoff.isWaiting(id: key) {
          overflowFlightID = key
          ChatSendHandoff.deliverAttachment(id: key, to: toggle, scrollDistance: scrollDistance)
        } else if key != overflowFlightID {
          ChatSendHandoff.cancel(id: key)
        }
      } else {
        ChatSendHandoff.deliverAttachment(id: key, to: tile, scrollDistance: scrollDistance)
      }
    }
  }
}
