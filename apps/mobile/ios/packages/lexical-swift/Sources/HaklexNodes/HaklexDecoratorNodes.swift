import Lexical
import UIKit

extension NodeType {
  public static let haklexMention = NodeType(rawValue: "mention")
  public static let haklexCodeBlock = NodeType(rawValue: "code-block")
  public static let horizontalRule = NodeType(rawValue: "horizontalrule")
}

public final class MentionNode: DecoratorNode {
  enum CodingKeys: String, CodingKey {
    case platform
    case handle
    case displayName
  }

  public private(set) var platform = ""
  public private(set) var handle = ""
  public private(set) var displayName: String?

  public convenience init(platform: String, handle: String, displayName: String? = nil, key: NodeKey? = nil) {
    self.init(key)
    self.platform = platform
    self.handle = handle
    self.displayName = displayName
  }

  public required init(_ key: NodeKey?) {
    super.init(key)
  }

  public required init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try super.init(from: decoder)
    platform = try container.decode(String.self, forKey: .platform)
    handle = try container.decode(String.self, forKey: .handle)
    displayName = try container.decodeIfPresent(String.self, forKey: .displayName)
  }

  override public func encode(to encoder: Encoder) throws {
    try super.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(platform, forKey: .platform)
    try container.encode(handle, forKey: .handle)
    try container.encodeIfPresent(displayName, forKey: .displayName)
  }

  override public class func getType() -> NodeType { .haklexMention }

  override public func clone() -> Self {
    Self(platform: platform, handle: handle, displayName: displayName, key: key)
  }

  private var label: String { "@" + (displayName ?? handle) }

  override public func createView() -> UIView {
    let view = UILabel()
    view.textColor = .link
    return view
  }

  override public func decorate(view: UIView) {
    (view as? UILabel)?.text = label
  }

  override public func sizeForDecoratorView(textViewWidth: CGFloat, attributes: [NSAttributedString.Key: Any]) -> CGSize {
    let font = attributes[.font] as? UIFont ?? .preferredFont(forTextStyle: .body)
    let size = (label as NSString).size(withAttributes: [.font: font])
    return CGSize(width: ceil(size.width), height: ceil(font.lineHeight))
  }
}

public final class CodeBlockNode: DecoratorNode {
  enum CodingKeys: String, CodingKey {
    case code
    case language
  }

  public private(set) var code = ""
  public private(set) var language = ""

  public convenience init(code: String, language: String, key: NodeKey? = nil) {
    self.init(key)
    self.code = code
    self.language = language
  }

  public required init(_ key: NodeKey?) {
    super.init(key)
  }

  public required init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try super.init(from: decoder)
    code = try container.decodeIfPresent(String.self, forKey: .code) ?? ""
    language = try container.decodeIfPresent(String.self, forKey: .language) ?? ""
  }

  override public func encode(to encoder: Encoder) throws {
    try super.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(code, forKey: .code)
    try container.encode(language, forKey: .language)
  }

  override public class func getType() -> NodeType { .haklexCodeBlock }

  override public func clone() -> Self {
    Self(code: code, language: language, key: key)
  }

  private static let font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
  private static let inset: CGFloat = 8

  override public func createView() -> UIView {
    let view = UILabel()
    view.font = Self.font
    view.numberOfLines = 0
    view.backgroundColor = .secondarySystemBackground
    return view
  }

  override public func decorate(view: UIView) {
    (view as? UILabel)?.text = code
  }

  override public func sizeForDecoratorView(textViewWidth: CGFloat, attributes: [NSAttributedString.Key: Any]) -> CGSize {
    let bounds = (code as NSString).boundingRect(
      with: CGSize(width: max(textViewWidth - 2 * Self.inset, 1), height: .greatestFiniteMagnitude),
      options: .usesLineFragmentOrigin, attributes: [.font: Self.font], context: nil)
    return CGSize(width: textViewWidth, height: ceil(bounds.height) + 2 * Self.inset)
  }
}

public final class HorizontalRuleNode: DecoratorNode {
  override public class func getType() -> NodeType { .horizontalRule }

  override public func clone() -> Self {
    Self(key)
  }

  override public func createView() -> UIView {
    let view = UIView()
    let line = UIView()
    line.backgroundColor = .separator
    line.autoresizingMask = [.flexibleWidth, .flexibleTopMargin, .flexibleBottomMargin]
    line.frame = CGRect(x: 0, y: 8, width: 1, height: 1)
    view.addSubview(line)
    return view
  }

  override public func sizeForDecoratorView(textViewWidth: CGFloat, attributes: [NSAttributedString.Key: Any]) -> CGSize {
    CGSize(width: textViewWidth, height: 17)
  }
}
