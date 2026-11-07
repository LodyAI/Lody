/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

public final class NodeSelection: BaseSelection {

  public var nodes: Set<NodeKey>
  public var dirty: Bool = false

  public init(nodes: Set<NodeKey>) {
    self.nodes = nodes
  }

  public func clone() -> BaseSelection {
    return NodeSelection(nodes: nodes)
  }

  public func add(key: NodeKey) {
    dirty = true
    nodes.insert(key)
  }

  /// This confusingly named function removes nodes from the selection. It doesn't delete the nodes from the document!
  public func delete(key: NodeKey) {
    dirty = true
    nodes.remove(key)
  }

  public func clear() {
    dirty = true
    nodes.removeAll()
  }

  public func has(key: NodeKey) -> Bool {
    return nodes.contains(key)
  }

  public func getNodes() throws -> [Node] {
    let objects = self.nodes
    var nodesToReturn: [Node] = []
    for object in objects {
      if let node = getNodeByKey(key: object) {
        nodesToReturn.append(node)
      }
    }
    return nodesToReturn
  }

  public func extract() throws -> [Node] {
    return try getNodes()
  }

  public func getTextContent() throws -> String {
    let nodes = try getNodes()
    var textContent = ""
    for node in nodes {
      textContent.append(node.getTextContent())
    }
    return textContent
  }

  public func insertRawText(_ text: String) {
    // do nothing
  }

  public func isSelection(_ selection: BaseSelection) -> Bool {
    guard let selection = selection as? NodeSelection else {
      return false
    }
    return nodes == selection.nodes
  }

  public func insertNodes(nodes: [Node], selectStart: Bool = false) throws -> Bool {
    // TODO
    return false
  }

  public func deleteCharacter(isBackwards: Bool) throws {
    for node in try getNodes() {
      try node.remove()
    }
  }

  public func deleteWord(isBackwards: Bool) throws {
    try deleteCharacter(isBackwards: isBackwards)
  }

  public func deleteLine(isBackwards: Bool) throws {
    try deleteCharacter(isBackwards: isBackwards)
  }

  public func insertParagraph() throws {
    guard isSingleNode(), let node = try getNodes().first else {
      return
    }
    let rangeSelection = try rangeSelectionForNode(node)
    try rangeSelection.insertParagraph()
  }

  public func insertLineBreak(selectStart: Bool) throws {
    guard isSingleNode(), let node = try getNodes().first else {
      return
    }
    let rangeSelection = try rangeSelectionForNode(node)
    try rangeSelection.insertLineBreak(selectStart: selectStart)
  }

  public func insertText(_ text: String) throws {
    guard isSingleNode(), let node = try getNodes().first else {
      return
    }
    let rangeSelection = try rangeSelectionForNode(node)
    try rangeSelection.insertText(text)
  }

  // MARK: - Private

  private func isSingleNode() -> Bool {
    return nodes.count == 1
  }

  // This function is specifically for getting a range selection for a single node in order to apply some incoming event to it,
  // e.g. some replacement text.
  private func rangeSelectionForNode(_ node: Node) throws -> RangeSelection {
    guard let parent = node.getParent(), let nodeIndexInParent = node.getIndexWithinParent() else {
      throw LexicalError.invariantViolation("cannot apply to root or unattached node")
    }
    let anchor = Point(key: parent.getKey(), offset: nodeIndexInParent, type: .element)
    let focus = Point(key: parent.getKey(), offset: nodeIndexInParent + 1, type: .element)
    return RangeSelection(anchor: anchor, focus: focus, format: TextFormat())
  }
}

extension NodeSelection: CustomDebugStringConvertible {
  public var debugDescription: String {
    return "Node Selection"
  }
}
