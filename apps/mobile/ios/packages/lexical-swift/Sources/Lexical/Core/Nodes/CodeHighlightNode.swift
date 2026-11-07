/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import UIKit

public class CodeHighlightNode: TextNode {
  enum CodingKeys: String, CodingKey {
    case highlightType
  }

  public var highlightType: String?

  override public init() {
    super.init()
  }

  required init(text: String, highlightType: String?, key: NodeKey? = nil) {
    super.init(text: text, key: key)
    self.highlightType = highlightType
  }

  public required init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try super.init(from: decoder)

    self.highlightType = try container.decodeIfPresent(String.self, forKey: .highlightType)
  }

  public required convenience init(text: String, key: NodeKey?) {
    self.init(text: text, highlightType: nil, key: key)
  }

  override public class func getType() -> NodeType {
    return .codeHighlight
  }

  override public func encode(to encoder: Encoder) throws {
    try super.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(self.highlightType, forKey: .highlightType)
  }

  override public func clone() -> Self {
    return Self(text: self.getText_dangerousPropertyAccess(), highlightType: self.highlightType, key: key)
  }

  // Prevent formatting (bold, underline, etc)
  override public func setFormat(format: TextFormat) throws -> CodeHighlightNode {
    return try self.getWritable()
  }
}
