import UIKit

@MainActor
enum LodyMenuButtonStyle {
  static let avatarSide: CGFloat = 32
  static let imagePadding: CGFloat = 8
  static let leadingInset: CGFloat = 2
  static let trailingInset: CGFloat = 10
  static let height: CGFloat = 44

  static func apply(_ value: UIButton.Configuration, to button: UIButton) {
    var configuration = value
    configuration.titleLineBreakMode = .byTruncatingTail
    configuration.subtitleLineBreakMode = .byTruncatingTail
    button.configuration = configuration
    button.titleLabel?.numberOfLines = 1
    button.titleLabel?.lineBreakMode = .byTruncatingTail
    button.subtitleLabel?.numberOfLines = 1
  }

  static func apply(label: String, avatar: UIImage, showsLabel: Bool = true, to button: UIButton) {
    var configuration = UIButton.Configuration.plain()
    configuration.image = avatar
    if !showsLabel {
      let inset = (height - avatarSide) / 2
      configuration.contentInsets = NSDirectionalEdgeInsets(top: inset, leading: inset, bottom: inset, trailing: inset)
      apply(configuration, to: button)
      return
    }
    configuration.imagePadding = imagePadding + 2
    configuration.titleAlignment = .leading
    configuration.titlePadding = 1
    configuration.contentInsets = NSDirectionalEdgeInsets(
      top: 2, leading: leadingInset, bottom: 2, trailing: trailingInset
    )
    let name = LodyDesign.font(.headline, size: 17, weight: .semibold)
    let title = NSMutableAttributedString(string: label, attributes: [.font: name, .foregroundColor: UIColor.lodyInk])
    if let chevron = UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .heavy)) {
      title.append(NSAttributedString(string: " ", attributes: [.font: name]))
      let attachment = NSTextAttachment(image: chevron.withTintColor(.lodySecondary, renderingMode: .alwaysOriginal))
      attachment.bounds = CGRect(x: 0, y: 1, width: chevron.size.width, height: chevron.size.height)
      title.append(NSAttributedString(attachment: attachment))
    }
    configuration.attributedTitle = AttributedString(title)
    apply(configuration, to: button)
  }

  static func unconstrainedWidth(for button: UIButton) -> CGFloat {
    button.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: height)).width
  }

  static func avatarImage(text: String, fill: UIColor, foreground: UIColor = .white, photo: UIImage?) -> UIImage {
    let side = avatarSide
    return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
      let bounds = CGRect(x: 0, y: 0, width: side, height: side)
      let circle = UIBezierPath(ovalIn: bounds)
      circle.addClip()
      if let photo {
        photo.draw(in: bounds)
        return
      }
      fill.setFill()
      circle.fill()
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 13, weight: .bold),
        .foregroundColor: foreground,
      ]
      let glyph = NSAttributedString(string: text, attributes: attributes)
      let size = glyph.size()
      glyph.draw(at: CGPoint(x: (side - size.width) / 2, y: (side - size.height) / 2))
    }.withRenderingMode(.alwaysOriginal)
  }
}
