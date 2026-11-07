/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

public enum SelectionType: String {
  case text = "text"
  case element = "element"
  case range = "range"
  case node = "node"
  case grid = "grid"
}

public final class Point {
  public var key: NodeKey
  public var offset: Int
  public var type: SelectionType
  internal weak var selection: BaseSelection?

  public init(key: NodeKey, offset: Int, type: SelectionType) {
    self.key = key
    self.offset = offset
    self.type = type
    self.selection = nil
  }

  func isBefore(point b: Point) throws -> Bool {
    var aNode = try getNode()
    var bNode = try b.getNode()
    let aOffset = offset
    let bOffset = b.offset

    if let elementNode = aNode as? ElementNode {
      aNode = elementNode.getDescendantByIndex(index: aOffset) ?? aNode
    }

    if let elementNode = bNode as? ElementNode {
      bNode = elementNode.getDescendantByIndex(index: bOffset) ?? bNode
    }

    if aNode == bNode {
      return aOffset < bOffset
    }

    return aNode.isBefore(bNode)
  }

  public func getNode() throws -> Node {
    guard let node = getNodeByKey(key: key) else {
      throw LexicalError.internal("Point.getNode: node not found")
    }

    return node
  }

  public func getOffset() -> Int {
    return offset
  }

  public func getType() -> SelectionType {
    return type
  }

  public func updatePoint(key: NodeKey, offset: Int, type: SelectionType) {
    self.key = key
    self.offset = offset
    self.type = type

    if !isReadOnlyMode() {
      if let selection {
        selection.dirty = true
      }
    }
  }

  func getCharacterOffset() -> Int {
    type == .text ? offset : 0
  }

  public func isAtNodeEnd() throws -> Bool {
    switch type {
    case .element:
      guard let elementNode = try getNode() as? ElementNode else {
        return false
      }
      return offset == elementNode.children.count

    case .text:
      guard let textNode = try getNode() as? TextNode else {
        return false
      }
      return offset == textNode.getTextPart().lengthAsNSString()
    case .range:
      throw LexicalError.invariantViolation("Need range selection")
    case .node:
      throw LexicalError.invariantViolation("Need node selection")
    case .grid:
      throw LexicalError.invariantViolation("Need grid selection")
    }
  }
}

extension Point: Equatable {
  public static func == (lhs: Point, rhs: Point) -> Bool {
    return lhs.key == rhs.key && lhs.offset == rhs.offset && lhs.type == rhs.type
  }
}

extension Point: CustomDebugStringConvertible {
  public var debugDescription: String {
    return "key: \(key), offset: \(offset), type: \(type) }"
  }
}
