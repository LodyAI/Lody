import UIKit

/// A file the Agent shared (`lody_upload_files`, web `SessionFileCard`): a type glyph, the name
/// and its size and kind. The whole card opens the file like a user attachment does.
final class ChatFileCardCell: UICollectionViewCell {
  static func height(traits: UITraitCollection) -> CGFloat {
    let name = UIFont.dynamic(of: 15, compatibleWith: traits).lineHeight
    let detail = UIFont.dynamic(of: 12.5, compatibleWith: traits).lineHeight
    return max(64, ceil(name + 2 + detail + 24)) + 12
  }

  private let card = UIView()
  private let badge = UIView()
  private let icon = UIImageView()
  private let nameLabel = UILabel()
  private let detailLabel = UILabel()
  private let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(card)
    card.backgroundColor = .secondarySystemGroupedBackground
    card.layer.cornerRadius = 14
    card.layer.cornerCurve = .continuous
    card.layer.borderWidth = 1 / max(1, traitCollection.displayScale)
    card.layer.borderColor = UIColor.separator.cgColor
    [badge, nameLabel, detailLabel, chevron].forEach(card.addSubview)
    badge.addSubview(icon)
    badge.backgroundColor = .tertiarySystemFill
    badge.layer.cornerRadius = 9
    badge.layer.cornerCurve = .continuous
    icon.tintColor = .secondaryLabel
    icon.contentMode = .scaleAspectFit
    nameLabel.textColor = .label
    nameLabel.lineBreakMode = .byTruncatingMiddle
    detailLabel.textColor = .secondaryLabel
    chevron.tintColor = .tertiaryLabel
    chevron.contentMode = .scaleAspectFit
    chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
    isAccessibilityElement = true
    accessibilityTraits = .button
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (cell: ChatFileCardCell, _) in
      cell.card.layer.borderColor = UIColor.separator.resolvedColor(with: cell.traitCollection).cgColor
    }
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: ChatRow) {
    guard let file = row.file else { return }
    icon.image = UIImage(systemName: Self.symbol(file), withConfiguration: UIImage.SymbolConfiguration(pointSize: 16))
    nameLabel.text = file.fileName
    nameLabel.font = UIFont.systemFont(ofSize: UIFont.dynamic(of: 15, compatibleWith: traitCollection).pointSize, weight: .medium)
    detailLabel.text = Self.detail(file)
    detailLabel.font = UIFont.dynamic(of: 12.5, compatibleWith: traitCollection)
    accessibilityLabel = [file.fileName, detailLabel.text ?? ""].filter { !$0.isEmpty }.joined(separator: ", ")
    accessibilityIdentifier = row.id
    setNeedsLayout()
  }

  static func detail(_ file: ChatMessageAttachment) -> String {
    var parts: [String] = []
    let ext = (file.fileName as NSString).pathExtension.uppercased()
    if !ext.isEmpty { parts.append(ext) }
    if let size = file.sizeBytes, size >= 0 {
      parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
    }
    return parts.joined(separator: " · ")
  }

  static func symbol(_ file: ChatMessageAttachment) -> String {
    let type = (file.mimeType ?? "").lowercased()
    let ext = (file.fileName as NSString).pathExtension.lowercased()
    if type.hasPrefix("image/") { return "photo" }
    if type.hasPrefix("video/") { return "film" }
    if type.hasPrefix("audio/") { return "waveform" }
    if type == "application/pdf" || ext == "pdf" { return "doc.richtext" }
    if type.contains("zip") || ["zip", "gz", "tgz", "tar", "7z"].contains(ext) { return "doc.zipper" }
    if ["html", "htm"].contains(ext) || type == "text/html" { return "globe" }
    if ["csv", "tsv", "xlsx", "xls"].contains(ext) { return "tablecells" }
    if ["md", "txt", "log", "json", "yaml", "yml", "xml"].contains(ext) || type.hasPrefix("text/") { return "doc.text" }
    return "doc"
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    card.frame = bounds.insetBy(dx: 0, dy: 6)
    let height = card.bounds.height
    badge.frame = CGRect(x: 12, y: (height - 36) / 2, width: 36, height: 36)
    icon.frame = badge.bounds.insetBy(dx: 9, dy: 9)
    chevron.frame = CGRect(x: card.bounds.width - 26, y: (height - 14) / 2, width: 12, height: 14)
    let x = badge.frame.maxX + 12
    let width = max(1, chevron.frame.minX - 10 - x)
    let nameHeight = ceil(nameLabel.font.lineHeight)
    let detailHeight = detailLabel.text?.isEmpty == false ? ceil(detailLabel.font.lineHeight) : 0
    let top = (height - nameHeight - (detailHeight > 0 ? 2 + detailHeight : 0)) / 2
    nameLabel.frame = CGRect(x: x, y: top, width: width, height: nameHeight)
    detailLabel.frame = CGRect(x: x, y: nameLabel.frame.maxY + 2, width: width, height: detailHeight)
  }
}
