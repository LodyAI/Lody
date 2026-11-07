/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

public class LineBreakNode: Node {
  override public init() {
    super.init()
  }

  override required init(_ key: NodeKey?) {
    super.init(key)
  }

  public required init(from decoder: Decoder) throws {
    try super.init(from: decoder)
  }

  override public class func getType() -> NodeType {
    .linebreak
  }

  override public func clone() -> Self {
    Self(key)
  }

  override public func getPostamble() -> String {
    return "\n"
  }

  public func createLineBreakNode() -> LineBreakNode {
    return LineBreakNode()
  }
}
