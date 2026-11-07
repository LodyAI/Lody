/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

/**
 Provides styling information for Lexical nodes.

 A Theme maps a ``NodeType`` to an array of NSAttributedString keys. It is up to the node class to decide what to do with this information. Most nodes will
 directly return the attributes in ``Node/getAttributedStringAttributes(theme:)``, passing them straight to TextKit, although this is not required.

 To set attributes on a theme, use the node type as if it were a property on the `Theme` class. For example:

 ```swift
 let theme: Theme()
 theme.paragraph = [
 .font: myFont,
 .lineHeight: 16.0,
 .foregroundColor: UIColor.black,
 ]
 ```

 Some nodes may require more than just one attributes dictionary. For example, a ``HeadingNode`` will want separate attributes for each possible heading size.
 To do this, use the ``Theme/setValue(_:forSubtype:value:)`` method. It is up to the node class to decide how to handle subtypes.

 ### Block level attributes

 There is some support for block level attributes, however this API could stand to be expanded in the future!

 For some context, TextKit 1 (which is what Lexical uses)
 lets attributes apply to a character range, or to a paragraph (by means of a subclass of `NSParagraphStyle`). A paragraph is defined
 by TextKit as a piece of text surrounded by line break characters.

 Consider, however, something like a code block. This is very likely to have multiple line breaks internally, but in order to style it, we might want to have
 a larger margin at the top of the code block and the bottom of the code block. Telling TextKit how to render this is difficult -- we have to set a paragraph style
 on the first paragraph of the code block with a bigger top margin, and a paragraph style on the last paragraph of the code block with a bigger bottom margin.

 Since Lexical wants to make a developer's life easier, we do this calculation internally. Our ``BlockLevelAttributes`` currently support margin and padding for top and
 bottom. This can be used in combination with Lexical's custom drawing support, to get the look you want. Apply block level attributes with ``Theme/setBlockLevelAttributes(_:value:)``.

 ## See Also

 - ``Node/getAttributedStringAttributes(theme:)``
 - ``Node/getBlockLevelAttributes(theme:)``
 */
@dynamicMemberLookup
@objc open class Theme: NSObject {
  public typealias AttributeDict = [NSAttributedString.Key: Any]
  private struct Key: Hashable, Equatable {
    internal init(_ nodeType: NodeType, _ subkey: String? = nil) {
      self.nodeType = nodeType
      self.subkey = subkey
    }

    let nodeType: NodeType
    let subkey: String?
  }

  /// The width in points of each indentation level.
  public var indentSize: Double = 40.0

  /// A set of attributes applied to a custom truncation indicator (a string that is displayed when the text overflows,
  /// such as an ellipsis or "See More" or similar).
  public var truncationIndicatorAttributes: AttributeDict = [:]

  private var attributes: [Key: AttributeDict] = [:]
  private var blockLevelAttributes: [NodeType: BlockLevelAttributes] = [:]

  public subscript(dynamicMember member: String) -> AttributeDict? {
    get {
      let nodeType: NodeType = NodeType(rawValue: member)
      return attributes[Key(nodeType)]
    }
    set {
      let nodeType: NodeType = NodeType(rawValue: member)
      attributes[Key(nodeType)] = newValue
    }
  }

  public func getValue(_ nodeType: NodeType, withSubtype subtype: String?) -> AttributeDict? {
    attributes[Key(nodeType, subtype)]
  }

  public func setValue(_ nodeType: NodeType, forSubtype subtype: String?, value: AttributeDict) {
    attributes[Key(nodeType, subtype)] = value
  }

  public func getBlockLevelAttributes(_ nodeType: NodeType) -> BlockLevelAttributes? {
    blockLevelAttributes[nodeType]
  }

  public func setBlockLevelAttributes(_ nodeType: NodeType, value: BlockLevelAttributes?) {
    blockLevelAttributes[nodeType] = value
  }
}
