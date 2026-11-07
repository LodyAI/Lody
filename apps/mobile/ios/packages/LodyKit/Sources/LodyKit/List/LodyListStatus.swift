import UIKit

enum LodyListStatus {
  static func color(_ status: String) -> UIColor? {
    switch status {
    case "online": .systemGreen
    case "offline": .systemGray
    case "unknown": .systemGray3
    default: nil
    }
  }

  // Content configurations take one image, so the badge is drawn into it.
  // The ring uses the cell color to cut the dot out of the glyph.
  static func badged(_ image: UIImage?, tint: UIColor, status: String, traits: UITraitCollection) -> UIImage? {
    guard let dot = color(status), let image else { return image }
    let glyph = image.applyingSymbolConfiguration(LodyListGlyph.symbolConfiguration) ?? image
    return render(glyph, size: glyph.size, tint: tint, dot: dot, diameter: 9, ring: 2, traits: traits)
  }

  private static func render(
    _ glyph: UIImage, size: CGSize, tint: UIColor, dot: UIColor, diameter: CGFloat, ring: CGFloat, traits: UITraitCollection
  ) -> UIImage {
    UIGraphicsImageRenderer(size: size).image { _ in
      glyph.withTintColor(tint.resolvedColor(with: traits), renderingMode: .alwaysOriginal)
        .draw(in: CGRect(origin: .zero, size: size))
      let frame = CGRect(
        x: size.width - diameter + ring / 2,
        y: size.height - diameter + ring / 2,
        width: diameter,
        height: diameter
      )
      UIColor.secondarySystemGroupedBackground.resolvedColor(with: traits).setFill()
      UIBezierPath(ovalIn: frame.insetBy(dx: -ring, dy: -ring)).fill()
      dot.resolvedColor(with: traits).setFill()
      UIBezierPath(ovalIn: frame).fill()
    }.withRenderingMode(.alwaysOriginal)
  }

  static func header(_ text: String, status: String, font: UIFont, color: UIColor) -> NSAttributedString? {
    guard let dot = self.color(status),
          let image = UIImage(systemName: "circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 7))?
            .withTintColor(dot, renderingMode: .alwaysOriginal) else { return nil }
    let attachment = NSTextAttachment(image: image)
    attachment.bounds = CGRect(x: 0, y: (font.capHeight - image.size.height) / 2, width: image.size.width, height: image.size.height)
    let result = NSMutableAttributedString(attachment: attachment)
    result.append(NSAttributedString(string: "  " + text, attributes: [.font: font, .foregroundColor: color]))
    return result
  }

  static func symbolLabel(_ symbol: String, text: String, color: UIColor) -> UIView {
    let label = UILabel()
    label.font = .preferredFont(forTextStyle: .body)
    label.adjustsFontForContentSizeCategory = true
    label.isAccessibilityElement = false
    let value = NSMutableAttributedString()
    if let image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(textStyle: .subheadline)) {
      value.append(NSAttributedString(attachment: NSTextAttachment(image: image.withTintColor(color, renderingMode: .alwaysOriginal))))
      value.append(NSAttributedString(string: " "))
    }
    value.append(NSAttributedString(string: text, attributes: [.foregroundColor: color]))
    label.attributedText = value
    label.sizeToFit()
    return label
  }

  static func trailingGlyph(_ symbol: String) -> UIView {
    let view = UIImageView(image: UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(textStyle: .subheadline)))
    view.tintColor = .secondaryLabel
    view.isAccessibilityElement = false
    view.sizeToFit()
    return view
  }
}
