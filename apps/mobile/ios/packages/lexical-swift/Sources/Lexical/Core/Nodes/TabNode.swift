import Foundation

public class TabNode: TextNode {
  override public init() {
    super.init(text: "\t", key: nil)
    detail.isUnmergable = true
  }

  public required init(_ key: NodeKey?) {
    super.init(text: "\t", key: key)
    detail.isUnmergable = true
  }

  public required init(text: String, key: NodeKey?) {
    super.init(text: text, key: key)
  }

  public required init(from decoder: Decoder) throws {
    try super.init(from: decoder)
  }

  override public class func getType() -> NodeType {
    .tab
  }

  override public func clone() -> Self {
    Self(text: getText_dangerousPropertyAccess(), key: key)
  }
}
