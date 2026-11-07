import Lexical
import UIKit

extension NodeType {
  static let lodyReference = NodeType(rawValue: "lody-reference")
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
    return attributes
  }
}
