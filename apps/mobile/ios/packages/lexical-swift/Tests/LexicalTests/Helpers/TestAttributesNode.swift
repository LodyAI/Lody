/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import Lexical

/// TestAttributesNode class has been added for unit tests
class TestAttributesNode: ElementNode {
  override required init() {
    super.init()
  }

  public required init(from decoder: Decoder) throws {
    try super.init(from: decoder)
  }

  override class func getType() -> NodeType {
    return NodeType(rawValue: "TestNode")
  }

  override open func getAttributedStringAttributes(theme: Theme) -> [NSAttributedString.Key: Any] {
    var attributeDictionary = super.getAttributedStringAttributes(theme: theme)
    attributeDictionary[.fontFamily] = "Arial"
    attributeDictionary[.fontSize] = 10 as Float
    attributeDictionary[.bold] = true

    return attributeDictionary
  }

  override public func clone() -> Self {
    Self()
  }
}
