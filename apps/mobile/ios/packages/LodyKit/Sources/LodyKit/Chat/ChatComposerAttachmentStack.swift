import UIKit

final class ChatComposerAttachmentStack: UIView {
  static let side: CGFloat = 28
  private static let spacing: CGFloat = 4
  private static let limit = 3
  private var tiles: [UIView] = []
  private var renderedIDs: [String] = []
  private var widthConstraint: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = true
    accessibilityIdentifier = "session-attachment-stack"
    widthConstraint = widthAnchor.constraint(equalToConstant: 0)
    widthConstraint.isActive = true
    heightAnchor.constraint(equalToConstant: Self.side).isActive = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  var stackWidth: CGFloat { widthConstraint.constant }

  func render(_ attachments: [ChatAttachment]) {
    accessibilityLabel = attachments.map(\.name).joined(separator: ", ")
    let shown = Array(attachments.prefix(Self.limit))
    guard shown.map(\.id) != renderedIDs else { return }
    renderedIDs = shown.map(\.id)
    tiles.forEach { $0.removeFromSuperview() }
    tiles = shown.enumerated().map { index, attachment in
      let tile = Self.tile(for: attachment)
      tile.frame = CGRect(x: CGFloat(index) * (Self.side + Self.spacing), y: 0, width: Self.side, height: Self.side)
      return tile
    }
    tiles.forEach(addSubview)
    widthConstraint.constant = shown.isEmpty ? 0 : Self.side + CGFloat(shown.count - 1) * (Self.side + Self.spacing)
  }

  private static func tile(for attachment: ChatAttachment) -> UIView {
    let tile = UIView(frame: CGRect(x: 0, y: 0, width: side, height: side))
    tile.layer.cornerRadius = 7
    tile.layer.cornerCurve = .continuous
    tile.clipsToBounds = true
    tile.backgroundColor = .tertiarySystemFill
    let content = UIImageView(frame: CGRect(x: 0, y: 0, width: side, height: side))
    content.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    if attachment.isImage, let image = ChatAttachment.thumbnail(attachment.url)?.preparingThumbnail(of: CGSize(width: 56, height: 56)) {
      content.image = image
      content.contentMode = .scaleAspectFill
    } else {
      content.image = UIImage(systemName: "doc", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium))
      content.tintColor = .secondaryLabel
      content.contentMode = .center
    }
    tile.addSubview(content)
    return tile
  }
}
