import Lexical
import UIKit

extension NodeType {
  static let lodyReference = NodeType(rawValue: "lody-reference")
}

extension NSAttributedString.Key {
  /// The tint of the rounded chip drawn behind a reference (files, skills, Agent Roles, …).
  static let lodyReferenceChip = NSAttributedString.Key("lodyReferenceChip")
}

// Display text and wire token travel together through editing, undo and draft restoration.
final class ChatReferenceNode: TextNode {
  var referenceToken: String?
  private enum CodingKeys: String, CodingKey { case referenceToken }

  required init(text: String, key: NodeKey?) {
    super.init(text: text, key: key)
    mode = .token
  }

  required init(from decoder: Decoder) throws {
    try super.init(from: decoder)
    referenceToken = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(String.self, forKey: .referenceToken)
  }

  override func encode(to encoder: Encoder) throws {
    try super.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(referenceToken, forKey: .referenceToken)
  }

  override class func getType() -> NodeType { .lodyReference }

  override func clone() -> Self {
    let node = Self(text: getText_dangerousPropertyAccess(), key: key)
    node.referenceToken = referenceToken
    return node
  }

  override func getAttributedStringAttributes(theme: Theme) -> [NSAttributedString.Key: Any] {
    var attributes = super.getAttributedStringAttributes(theme: theme)
    attributes[.foregroundColor] = UIColor.lodyAccent
    attributes[.lodyReferenceChip] = Self.chipFill
    return attributes
  }

  private static let chipFill = UIColor.lodyAccent.withAlphaComponent(0.14)

  /// Draws each line's run of a reference as a rounded chip, so a chosen reference reads apart
  /// from the typed text (web's mention chip) rather than as accent-coloured text alone.
  static func registerChipDrawing(in editor: Editor) {
    try? editor.registerCustomDrawing(customAttribute: .lodyReferenceChip, layer: .background, granularity: .characterRuns) {
      _, value, _, _, _, _, rect, _ in
      guard let fill = value as? UIColor, rect.width > 0 else { return }
      let chip = rect.insetBy(dx: -2, dy: 1)
      fill.setFill()
      UIBezierPath(roundedRect: chip, cornerRadius: min(6, chip.height / 2)).fill()
    }
  }
}
