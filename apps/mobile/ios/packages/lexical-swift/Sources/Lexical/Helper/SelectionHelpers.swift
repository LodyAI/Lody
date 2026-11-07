/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

// Leaving commented code for later when these properties/nodes are implemented
public func cloneWithProperties<T: Node>(node: T) throws -> Node {
  let latest = node.getLatest()
  let clone = latest.clone()
  clone.parent = latest.parent
  if let latestTextNode = latest as? TextNode,
    let latestCloneNode = clone as? TextNode
  {
    latestCloneNode.format = latestTextNode.format
    latestCloneNode.style = latestTextNode.style
    latestCloneNode.mode = latestTextNode.mode
    latestCloneNode.detail = latestTextNode.detail
    return latestCloneNode
  } else if let latestElementNode = latest as? ElementNode,
    let latestCloneNode = clone as? ElementNode
  {
    latestCloneNode.children = latestElementNode.children
    latestCloneNode.direction = latestElementNode.direction
    //    latestCloneNode.indent = latestElementNode.indent
    //    latestCloneNode.format = latestElementNode.format
    return latestCloneNode
    //  } else if ($isDecoratorNode(latest) && $isDecoratorNode(clone)) {
    //    clone.state = latest.state
  }

  return clone
}

func getIndexFromPossibleClone(
  node: Node,
  parent: ElementNode,
  nodeMap: [NodeKey: Node]
) -> Int? {
  let parentClone = nodeMap[parent.getKey()]
  if let parentElement = parentClone as? ElementNode {
    return parentElement.children.firstIndex(of: node.key)
  }
  return node.getIndexWithinParent()
}

// Only node that is excluded in JS currently is "LexicalOverflowNode"›
func getParentAvoidingExcludedElements(node: Node) -> ElementNode? {
  var parent = node.getParent()
  while let unwrappedParent = parent, unwrappedParent.excludeFromCopy() {
    parent = unwrappedParent.getParent()
  }

  return parent
}

func copyLeafNodeBranchToRoot(
  leaf: Node,
  startingOffset: Int,
  isLeftSide: Bool,
  range: [NodeKey],
  nodeMap: [NodeKey: Node]
) throws -> (range: [NodeKey], nodeMap: [NodeKey: Node]) {
  var mutableRange = range
  var mutableNodeMap = nodeMap

  var node: Node? = leaf
  var offset = startingOffset
  while let unwrappedNode = node {
    guard let parent = getParentAvoidingExcludedElements(node: unwrappedNode) else { break }

    if !((unwrappedNode as? ElementNode)?.excludeFromCopy() ?? false) || !isElementNode(node: unwrappedNode) {
      let key = unwrappedNode.getKey()
      var clone = mutableNodeMap[key]
      let needsClone = clone == nil
      if needsClone {
        clone = try cloneWithProperties(node: unwrappedNode)
        mutableNodeMap[key] = clone
      }
      if let textClone = clone as? TextNode, !textClone.isSegmented() && !textClone.isToken() {
        let textCloneText = textClone.getText_dangerousPropertyAccess() as NSString
        let length = textCloneText.length - (isLeftSide ? offset : 0) - (isLeftSide ? 0 : textCloneText.length - offset)

        let range = NSRange(location: isLeftSide ? offset : 0, length: length)
        let subString = textCloneText.substring(with: range)
        textClone.setText_dangerousPropertyAccess(String(subString))
        mutableNodeMap[key] = textClone
      } else if let elementClone = clone as? ElementNode {
        let start = isLeftSide ? offset : 0
        let end = isLeftSide ? elementClone.getChildrenSize() : offset + 1
        if elementClone.getChildrenSize() > 0 {
          elementClone.children = Array(elementClone.children[start..<end])
        }

        mutableNodeMap[key] = elementClone
      }
      if isRootNode(node: parent) {
        if needsClone {
          // We only want to collect a range of top level nodes.
          // So if the parent is the root, we know this is a top level.
          mutableRange.append(key)
        }
        break
      }
    }

    offset = getIndexFromPossibleClone(node: unwrappedNode, parent: parent, nodeMap: nodeMap) ?? -1
    node = parent
  }

  return (range: mutableRange, nodeMap: mutableNodeMap)
}

public func cloneContents(
  selection: RangeSelection
) throws -> (
  nodeMap: [NodeKey: Node],
  range: [NodeKey]
) {
  let anchor = selection.anchor
  let focus = selection.focus
  let anchorOffset = anchor.getCharacterOffset()
  let focusOffset = focus.getCharacterOffset()
  let anchorNode = try anchor.getNode()
  let focusNode = try focus.getNode()
  let anchorNodeParent = try anchorNode.getParentOrThrow()

  // Handle a single text node extraction
  if let anchorTextNode = anchorNode as? TextNode,
    anchorNode.isSameKey(focusNode) && (anchorNodeParent.canBeEmpty() || anchorNodeParent.getChildrenSize() > 1)
  {
    guard let clonedFirstNode = try cloneWithProperties(node: anchorTextNode) as? TextNode else {
      throw LexicalError.internal("Could not clone anchorNode as TextNode")
    }
    let isBefore = focusOffset > anchorOffset
    let textCloneText = clonedFirstNode.getText_dangerousPropertyAccess() as NSString
    let startOffset = isBefore ? anchorOffset : focusOffset
    let endOffset = isBefore ? focusOffset : anchorOffset
    let subString = textCloneText.substring(with: NSRange(location: startOffset, length: endOffset - startOffset))

    clonedFirstNode.setText_dangerousPropertyAccess(String(subString))

    let key = clonedFirstNode.getKey()
    return (nodeMap: [key: clonedFirstNode], range: [key])
  }
  var nodes = try selection.getNodes()
  if nodes.isEmpty {
    return (nodeMap: [:], range: [])
  }
  // Check if we can use the parent of the nodes, if the
  // parent can't be empty, then it's important that we
  // also copy that element node along with its children.
  var nodesLength = nodes.count
  let firstNode = nodes[0]
  if let firstNodeParent = firstNode.getParent(),
    !firstNodeParent.canBeEmpty() || isRootNode(node: firstNodeParent)
  {
    let parentChildren = firstNodeParent.children
    let parentChildrenLength = parentChildren.count
    if parentChildrenLength == nodesLength {
      var areTheSame = true
      for i in 0..<parentChildren.count {
        if parentChildren[i] != nodes[i].key {
          areTheSame = false
          break
        }
      }
      if areTheSame {
        nodesLength += 1
        nodes.append(firstNodeParent)
      }
    }
  }
  let lastNode = nodes[nodesLength - 1]
  let isBefore = try anchor.isBefore(point: focus)
  var nodeMap: [NodeKey: Node] = [:]
  var range: [NodeKey] = []

  // Do first node to root
  (range, nodeMap) = try copyLeafNodeBranchToRoot(
    leaf: firstNode,
    startingOffset: isBefore ? anchorOffset : focusOffset,
    isLeftSide: true,
    range: range,
    nodeMap: nodeMap
  )
  // Copy all nodes between
  for i in 0..<nodesLength - 1 {
    let node = nodes[i]
    let key = node.getKey()
    if nodeMap[key] == nil && (!((node as? ElementNode)?.excludeFromCopy() ?? false) || !isElementNode(node: node)) {
      let clone = try cloneWithProperties(node: node)
      if isRootNode(node: node.getParent()) {
        range.append(node.getKey())
      }
      nodeMap[key] = clone
    }
  }
  // Do last node to root
  (range, nodeMap) = try copyLeafNodeBranchToRoot(
    leaf: lastNode,
    startingOffset: isBefore ? focusOffset : anchorOffset,
    isLeftSide: false,
    range: range,
    nodeMap: nodeMap
  )

  var outputNodeArray: [(NodeKey, Node)] = nodeMap.map {
    ($0, $1)
  }

  outputNodeArray = outputNodeArray.sorted(by: { $0.0 < $1.0 })

  return (nodeMap, range)
}
