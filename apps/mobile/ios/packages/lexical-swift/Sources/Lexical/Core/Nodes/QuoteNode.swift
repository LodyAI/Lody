/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import UIKit

public class QuoteNode: ElementNode {
  override public init() {
    super.init()
  }

  override public required init(_ key: NodeKey?) {
    super.init(key)
  }

  public required init(from decoder: Decoder) throws {
    try super.init(from: decoder)
  }

  override public class func getType() -> NodeType {
    return .quote
  }

  override public func clone() -> Self {
    Self(key)
  }

  override public func getAttributedStringAttributes(theme: Theme) -> [NSAttributedString.Key: Any] {
    theme.quote ?? [:]
  }

  override public func getIndent() -> Int {
    1
  }

  // MARK: - Mutation

  override open func insertNewAfter(selection: RangeSelection?) throws -> Node? {
    let newBlock = createParagraphNode()
    let direction = getDirection()
    try newBlock.setDirection(direction: direction)

    try insertAfter(nodeToInsert: newBlock)

    return newBlock
  }

  override public func collapseAtStart(selection: RangeSelection) throws -> Bool {
    let paragraph = createParagraphNode()
    let children = getChildren()
    try children.forEach({ try paragraph.append([$0]) })
    try replace(replaceWith: paragraph)

    return true
  }
}

@objc public class QuoteCustomDrawingAttributes: NSObject {
  public init(barColor: UIColor, barWidth: CGFloat, rounded: Bool, barInsets: UIEdgeInsets) {
    self.barColor = barColor
    self.barWidth = barWidth
    self.rounded = rounded
    self.barInsets = barInsets
  }

  let barColor: UIColor
  let barWidth: CGFloat
  let rounded: Bool
  let barInsets: UIEdgeInsets

  override public func isEqual(_ object: Any?) -> Bool {
    let lhs = self
    guard let rhs = object as? QuoteCustomDrawingAttributes else {
      return false
    }
    return lhs.barColor == rhs.barColor && lhs.barWidth == rhs.barWidth && lhs.rounded == rhs.rounded && lhs.barInsets == rhs.barInsets
  }
}

public extension NSAttributedString.Key {
  static let quoteCustomDrawing: NSAttributedString.Key = .init(rawValue: "quoteCustomDrawing")
}

extension QuoteNode {
  internal static var quoteBackgroundDrawing: CustomDrawingHandler {
    get {
      return { attributeKey, attributeValue, textStorage, attributeRunCharacterRange, granularityExpandedCharacterRange, glyphRange, rect, firstLineFragment in
        guard let attributeValue = attributeValue as? QuoteCustomDrawingAttributes else { return }

        let barRect = CGRect(
          x: rect.minX + attributeValue.barInsets.left,
          y: rect.minY + attributeValue.barInsets.top,
          width: attributeValue.barWidth,
          height: rect.height - attributeValue.barInsets.top - attributeValue.barInsets.bottom)
        attributeValue.barColor.setFill()

        if attributeValue.rounded {
          let bezierPath = UIBezierPath(roundedRect: barRect, cornerRadius: attributeValue.barWidth / 2)
          bezierPath.fill()
        } else {
          UIRectFill(barRect)
        }
      }
    }
  }
}
