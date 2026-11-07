/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import UIKit

// This is an ObjC class because it needs to conform to NSObject's equality, otherwise the Layout Manager
// can't iterate through attributes properly.
@objc public class CodeBlockCustomDrawingAttributes: NSObject {
  public init(background: UIColor, border: UIColor, borderWidth: CGFloat) {
    self.background = background
    self.border = border
    self.borderWidth = borderWidth
  }

  let background: UIColor
  let border: UIColor
  let borderWidth: CGFloat

  override public func isEqual(_ object: Any?) -> Bool {
    let lhs = self
    guard let rhs = object as? CodeBlockCustomDrawingAttributes else {
      return false
    }
    return lhs.background == rhs.background && lhs.border == rhs.border && lhs.borderWidth == rhs.borderWidth
  }
}

public extension NSAttributedString.Key {
  static let codeBlockCustomDrawing: NSAttributedString.Key = .init(rawValue: "codeBlockCustomDrawing")
}

public class CodeNode: ElementNode {
  enum CodingKeys: String, CodingKey {
    case language
  }

  private var language: String = ""

  override public init() {
    super.init()
  }

  required init(language: String, key: NodeKey? = nil) {
    super.init(key)
    self.language = language
  }

  public required init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try super.init(from: decoder)

    self.language = try container.decodeIfPresent(String.self, forKey: .language) ?? ""
  }

  override public class func getType() -> NodeType {
    return .code
  }

  override public func encode(to encoder: Encoder) throws {
    try super.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    if !language.isEmpty {
      try container.encode(self.language, forKey: .language)
    }
  }

  public func getLanguage() -> String {
    let latest: CodeNode = getLatest()
    return latest.language
  }

  public func setLanguage(_ language: String) throws {
    try errorOnReadOnly()
    try getWritable().language = language
  }

  override func canInsertTab() -> Bool {
    return true
  }

  override public func clone() -> Self {
    Self(language: language, key: key)
  }

  override public func collapseAtStart(selection: RangeSelection) throws -> Bool {
    let paragraph = createParagraphNode()

    try getChildren().forEach { node in
      try paragraph.append([node])
    }

    try replace(replaceWith: paragraph)

    return true
  }

  override public func getAttributedStringAttributes(theme: Theme) -> [NSAttributedString.Key: Any] {
    var attributeDictionary = super.getAttributedStringAttributes(theme: theme)
    if let codeTheme = theme.code {
      attributeDictionary.merge(codeTheme) { (_, new) in new }
    } else {
      // a few defaults
      attributeDictionary[.paddingHead] = 4.0
      attributeDictionary[.paddingTail] = -4.0
    }

    if attributeDictionary[.codeBlockCustomDrawing] == nil {
      let customAttr = CodeBlockCustomDrawingAttributes(background: .lightGray, border: .gray, borderWidth: 1)
      attributeDictionary[.codeBlockCustomDrawing] = customAttr
    }

    return attributeDictionary
  }

  override open func insertNewAfter(selection: RangeSelection?) throws -> ParagraphNode? {
    guard let selection else {
      return nil
    }

    let children = self.getChildren()
    let childrenLength = children.count

    if childrenLength >= 2 && children.last is LineBreakNode && children[childrenLength - 2] is LineBreakNode && selection.isCollapsed() && selection.anchor.key == self.key && selection.anchor.offset == childrenLength {
      try children[childrenLength - 1].remove()
      try children[childrenLength - 2].remove()
      let newElement = createParagraphNode()
      try self.insertAfter(nodeToInsert: newElement)
      return newElement
    } else {
      return nil
    }
  }
}

extension CodeNode {
  internal static var codeBlockBackgroundDrawing: CustomDrawingHandler {
    get {
      return { attributeKey, attributeValue, textStorage, attributeRunCharacterRange, granularityExpandedCharacterRange, glyphRange, rect, firstLineFragment in
        guard let context = UIGraphicsGetCurrentContext(), let attributeValue = attributeValue as? CodeBlockCustomDrawingAttributes else { return }
        context.setFillColor(attributeValue.background.cgColor)
        context.fill(rect)

        context.setStrokeColor(attributeValue.border.cgColor)
        context.stroke(rect, width: attributeValue.borderWidth)
      }
    }
  }
}
