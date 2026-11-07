/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import UIKit

public class RootNode: ElementNode {

  override required init() {
    super.init(kRootNodeKey)
  }

  public required init(from decoder: Decoder) throws {
    try super.init(from: decoder)
  }

  override public func clone() -> Self {
    Self()
  }

  override public static func getType() -> NodeType {
    return .root
  }

  override public func getAttributedStringAttributes(theme: Theme) -> [NSAttributedString.Key: Any] {
    if let root = theme.root {
      return root
    }

    return [.font: LexicalConstants.defaultFont]
  }

  // Root nodes cannot have a preamble. If they did, there would be no way to make a selection of the
  // beginning of the document. The same applies to postamble.
  override public final func getPreamble() -> String {
    return ""
  }

  override public final func getPostamble() -> String {
    return ""
  }

  override public func insertBefore(nodeToInsert: Node) throws -> Node {
    throw LexicalError.invariantViolation("insertBefore: cannot be called on root nodes")
  }

  override public func remove() throws {
    throw LexicalError.invariantViolation("remove: cannot be called on root nodes")
  }

  override public func replace<T: Node>(replaceWith: T, includeChildren: Bool = false) throws -> T {
    throw LexicalError.invariantViolation("replace: cannot be called on root nodes")
  }

  override public func insertAfter(nodeToInsert: Node) throws -> Node {
    throw LexicalError.invariantViolation("insertAfter: cannot be called on root nodes")
  }
}

extension RootNode: CustomDebugStringConvertible {
  public var debugDescription: String {
    return "(RootNode: key '\(key)', id \(ObjectIdentifier(self))"
  }
}
