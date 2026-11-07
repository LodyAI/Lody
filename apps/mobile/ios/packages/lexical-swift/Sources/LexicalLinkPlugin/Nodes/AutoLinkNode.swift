import Lexical

extension NodeType {
  public static let autoLink = NodeType(rawValue: "autolink")
}

public class AutoLinkNode: LinkNode {
  enum AutoLinkCodingKeys: String, CodingKey {
    case isUnlinked
  }

  public var isUnlinked = false

  public required init(url: String, key: NodeKey?) {
    super.init(url: url, key: key)
  }

  public required init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: AutoLinkCodingKeys.self)
    try super.init(from: decoder)
    isUnlinked = try container.decodeIfPresent(Bool.self, forKey: .isUnlinked) ?? false
  }

  override open class func getType() -> NodeType {
    .autoLink
  }

  override open func encode(to encoder: Encoder) throws {
    try super.encode(to: encoder)
    var container = encoder.container(keyedBy: AutoLinkCodingKeys.self)
    try container.encode(isUnlinked, forKey: .isUnlinked)
  }

  override open func clone() -> Self {
    let node = super.clone()
    node.isUnlinked = isUnlinked
    return node
  }
}
