import UIKit

/// A user turn's header (read mark, time, name) and the sender's avatar, drawn on the turn's
/// first row: its attachments when it has some, otherwise its first bubble.
@MainActor
final class ChatAuthorHeader {
  static let avatarSize: CGFloat = 36
  static let avatarSlot: CGFloat = avatarSize + 10
  static let height: CGFloat = 22
  /// One secondary ink for the whole header (mark, time, name): quieter than the message,
  /// clearer than tertiary text.
  static let ink = UIColor.secondaryLabel

  let mark = UIImageView()
  let label = UILabel()
  let avatar = UIImageView()
  private var photo: URL?
  private var views: [UIView] { [mark, label, avatar] }

  init() {
    label.font = .dynamic(of: 13)
    label.textColor = Self.ink
    label.textAlignment = .right
    mark.contentMode = .scaleAspectFit
    mark.tintColor = Self.ink
    avatar.contentMode = .scaleAspectFill
    avatar.clipsToBounds = true
    avatar.layer.cornerRadius = Self.avatarSize / 2
  }

  func install(in container: UIView) {
    for view in views {
      view.isAccessibilityElement = false
      view.isHidden = true
      container.addSubview(view)
    }
  }

  /// Applies the row's sender and returns its spoken summary, or nil when the row has no header.
  @discardableResult
  func apply(_ row: ChatRow) -> String? {
    let shown = !row.author.isEmpty
    for view in views { view.isHidden = !shown }
    guard shown else { return nil }
    let who = (name: row.authorName.isEmpty ? String(localized: "native.chat.member", bundle: .lody) : row.authorName, image: row.authorImage)
    // Web's order: delivery mark, time, then the sender.
    label.text = [row.authorTime, who.name].filter { !$0.isEmpty }.joined(separator: "  ")
    // The mark shares the header's ink; its glyph alone tells the delivery state.
    let marks = ["seen": "checkmark.circle", "queued": "clock", "sending": "circle.dotted", "sent": "circle"]
    let symbol = marks[row.readState] ?? marks["sent"]!
    mark.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .regular))
    let monogram = LodyListPhoto.monogram(String(who.name.prefix(1)).uppercased(), side: Self.avatarSize)
    let url = LodyListPhoto.url(who.image)
    photo = url
    avatar.image = monogram
    if let url {
      if let cached = LodyListPhoto.image(for: url, ready: { [weak self] image in
        guard let self, self.photo == url else { return }
        self.avatar.image = image
      }) { avatar.image = cached }
    }
    let state = String(localized: String.LocalizationValue("native.chat.read." + row.readState), bundle: .lody)
    return [who.name, row.authorTime, state].filter { !$0.isEmpty }.joined(separator: ", ")
  }

  /// Lays the header out right-aligned above `contentTop`, ending at the avatar column, with
  /// the avatar beside the turn's first content.
  func layout(width: CGFloat, top: CGFloat) {
    guard !label.isHidden else { return }
    let right = width - Self.avatarSlot
    avatar.frame = CGRect(x: width - Self.avatarSize, y: top + Self.height, width: Self.avatarSize, height: Self.avatarSize)
    let labelWidth = min(right - 16, label.sizeThatFits(CGSize(width: right, height: Self.height)).width)
    label.frame = CGRect(x: right - labelWidth, y: top, width: labelWidth, height: Self.height - 4)
    mark.frame = CGRect(x: label.frame.minX - 18, y: label.frame.midY - 7, width: 14, height: 14)
  }
}
