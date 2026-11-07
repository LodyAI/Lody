/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

public func getNodeByKey<N: Node>(key: NodeKey) -> N? {
  guard let editorState = getActiveEditorState(), let node = editorState.nodeMap[key] else {
    return nil
  }
  return node as? N
}

@discardableResult
public func generateKey(node: Node) throws -> NodeKey? {
  try errorOnReadOnly()

  guard let editor = getActiveEditor(), let editorState = getActiveEditorState() else {
    return nil
  }

  while editorState.nodeMap[String(editor.keyCounter)] != nil {
    editor.keyCounter += 1
  }

  let key = editor.keyCounter
  editor.keyCounter += 1

  let stringKey = String(key)
  node.key = stringKey
  editorState.nodeMap[stringKey] = node
  editor.cloneNotNeeded.insert(stringKey)
  editor.dirtyType = .hasDirtyNodes
  editor.dirtyNodes[stringKey] = .editorInitiated
  return stringKey
}

private func internallyMarkChildrenAsDirty(
  element: ElementNode,
  nodeMap: [NodeKey: Node],
  editor: Editor,
  status: DirtyStatusCause = .editorInitiated
) {
  for childKey in element.children {
    editor.dirtyNodes[childKey] = status
    if let childElement = nodeMap[childKey] as? ElementNode {
      internallyMarkChildrenAsDirty(element: childElement, nodeMap: nodeMap, editor: editor)
    }
  }
}

private func internallyMarkParentElementsAsDirty(
  parentKey: NodeKey,
  nodeMap: [NodeKey: Node],
  editor: Editor,
  status: DirtyStatusCause = .editorInitiated
) {
  var nextParentKey: NodeKey? = parentKey

  while let unwrappedParentKey = nextParentKey {
    if editor.dirtyNodes[unwrappedParentKey] != nil {
      return
    }

    let node = nodeMap[unwrappedParentKey]

    if node == nil {
      break
    }

    editor.dirtyNodes[unwrappedParentKey] = status
    nextParentKey = node?.parent
  }
} // Never use this function directly! It will break
// the cloning heuristic. Instead use node.getWritable().

internal func internallyMarkNodeAsDirty(node: Node, cause: DirtyStatusCause = .editorInitiated) {
  let latest = node.getLatest()
  guard
    let editorState = getActiveEditorState(),
    let editor = getActiveEditor()
  else {
    fatalError()
  }

  let nodeMap = editorState.nodeMap

  if let parent = latest.parent {
    internallyMarkParentElementsAsDirty(parentKey: parent, nodeMap: nodeMap, editor: editor)
  }
  if let elementNode = node as? ElementNode {
    internallyMarkChildrenAsDirty(element: elementNode, nodeMap: nodeMap, editor: editor)
  }

  editor.dirtyType = .hasDirtyNodes
  editor.dirtyNodes[latest.key] = cause
}

internal func internallyMarkSiblingsAsDirty(node: Node, status: DirtyStatusCause = .editorInitiated) {
  if let previousNode = node.getPreviousSibling() {
    internallyMarkNodeAsDirty(node: previousNode, cause: status)
  }
  if let nextNode = node.getNextSibling() {
    internallyMarkNodeAsDirty(node: nextNode, cause: status)
  }
}

public func getCompositionKey() -> NodeKey? {
  return getActiveEditor()?.compositionKey
}

public func createTextNode(text: String?) -> TextNode {
  TextNode(text: text ?? "", key: nil)
}

public func createParagraphNode() -> ParagraphNode {
  ParagraphNode()
}

public func createHeadingNode(headingTag: HeadingTagType) -> HeadingNode {
  HeadingNode(tag: headingTag)
}

public func createQuoteNode() -> QuoteNode {
  QuoteNode()
}

public func createLineBreakNode() -> LineBreakNode {
  LineBreakNode()
}

public func createCodeNode(language: String = "") -> CodeNode {
  CodeNode(language: language)
}

public func createCodeHighlightNode(text: String, highlightType: String?) -> CodeHighlightNode {
  CodeHighlightNode(text: text, highlightType: highlightType)
}

public func toggleTextFormatType(format: TextFormat, type: TextFormatType, alignWithFormat: TextFormat?) -> TextFormat {
  var activeFormat = format
  let isStateFlagPresent = format.isTypeSet(type: type)
  var flag = false

  if let alignWithFormat {
    // remove the type from format
    if isStateFlagPresent && !alignWithFormat.isTypeSet(type: type) {
      flag = false
    }

    // add the type to format
    if alignWithFormat.isTypeSet(type: type) {
      flag = true
    }
  } else {
    if isStateFlagPresent {
      flag = false
    } else {
      flag = true
    }
  }

  activeFormat.updateFormat(type: type, value: flag)

  return activeFormat
}

public func isElementNode(node: Node?) -> Bool {
  node is ElementNode
}

public func isTextNode(_ node: Node?) -> Bool {
  node is TextNode
}

public func isRootNode(node: Node?) -> Bool {
  node is RootNode
}

public func isHeadingNode(_ node: Node?) -> Bool {
  node is HeadingNode
}

public func isQuoteNode(_ node: Node?) -> Bool {
  node is QuoteNode
}

public func isCodeNode(_ node: Node?) -> Bool {
  node is CodeNode
}

public func isCodeHighlightNode(_ node: Node?) -> Bool {
  node is CodeHighlightNode
}

public func isLineBreakNode(_ node: Node?) -> Bool {
  node is LineBreakNode
}

public func isDecoratorNode(_ node: Node?) -> Bool {
  node is DecoratorNode
}

// TODO: - update function when we add LineBreakNode and DecoratorNode
public func isLeafNode(_ node: Node?) -> Bool {
  node is TextNode || node is LineBreakNode
}

public func isTokenOrInert(_ node: TextNode?) -> Bool {
  guard let node else { return false }
  return node.isToken() || node.isInert()
}

public func isTokenOrInertOrSegmented(_ node: TextNode?) -> Bool {
  guard let node else { return false }
  return isTokenOrInert(node) || node.isSegmented()
}

public func isTokenOrSegmented(_ node: TextNode?) -> Bool {
  guard let node else { return false }
  return node.isToken() || node.isSegmented()
}

public func getRoot() -> RootNode? {
  guard let editorState = getActiveEditorState(),
    let rootNode = editorState.nodeMap[kRootNodeKey] as? RootNode
  else { return nil }

  return rootNode
}

func getEditorStateTextContent(editorState: EditorState) throws -> String {
  var textContent: String = ""

  try editorState.read {
    if let rootNode = getRoot() {
      textContent += rootNode.getTextContent()
    }
  }

  return textContent
}

public func getNodeHierarchy(editorState: EditorState?) throws -> String {
  var hierarchyString = ""
  var cacheString = ""
  var formatString = ""

  try editorState?.read {
    guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
      throw LexicalError.invariantViolation("Need editor and state")
    }

    let sortedNodeMap = editorState.nodeMap.sorted(
      by: { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    )

    var currentNodes: [(Node, Int)] = [(rootNode, 0)]
    var description: [String] = []

    repeat {
      let (node, depth) = currentNodes.removeLast()

      let indentation = (0..<depth).map({ _ in "\t " }).joined(separator: "")

      if let textNode = node as? TextNode {
        if textNode.format.debugDescription != "" {
          formatString = "{ format: \(textNode.format.debugDescription) }"
        } else {
          formatString = ""
        }
        description.append("\(indentation)(\(node.key)) \(node.type.rawValue) \"\(textNode.getTextPart())\" \(formatString)")
      } else {
        description.append("\(indentation)(\(node.key)) \(node.type.rawValue)")
      }

      if let elementNode = node as? ElementNode {
        let childNodes = elementNode.children.map({ (getNodeByKey(key: $0) ?? Node(), depth + 1) }).reversed()
        currentNodes.append(contentsOf: childNodes)
      }
    } while !currentNodes.isEmpty

    hierarchyString = description.joined(separator: "\n")
    cacheString = sortedNodeMap.map({ node in "\(node.key): \(node.value.type)" }).joined(separator: ", ")
  }

  return "Tree:\n\(hierarchyString)\nCache:\n\(cacheString)"
}

public func getSelectionData(editorState: EditorState?) throws -> String {
  var selectionString = "selection: range\n"

  guard let debugDescription = editorState?.selection?.debugDescription else {
    throw LexicalError.invariantViolation("Need selection")
  }

  selectionString += debugDescription

  return selectionString
}

public func removeParentEmptyElements(startingNode: ElementNode?) throws {
  guard var node = startingNode else { return }

  while !(node is RootNode) {
    let latest = node.getLatest()

    let parentNode = try latest.getParentOrThrow()

    if latest.children.isEmpty {
      try node.remove()
    }

    node = parentNode
  }
}

func checkSelectionIsOnlyLinebreak(selection: RangeSelection) throws -> Bool {
  let nodes = try selection.getNodes()
  return nodes.count == 1 && nodes.contains(where: { $0 is LineBreakNode })
}

public func sliceSelectedTextNodeContent(selection: BaseSelection, textNode: TextNode) throws -> TextNode {
  if try textNode.isSelected(), !textNode.isSegmented(), !textNode.isToken(), let selection = selection as? RangeSelection {
    // && ($isRangeSelection(selection) || $isGridSelection(selection)){
    let anchorNode = try selection.anchor.getNode()
    let focusNode = try selection.focus.getNode()
    let isAnchor = textNode == anchorNode
    let isFocus = textNode == focusNode

    if isAnchor || isFocus {
      let isBackward = try selection.isBackward()
      let (anchorOffset, focusOffset) = selection.getCharacterOffsets(selection: selection)
      let isSame = anchorNode == focusNode
      let isFirst = textNode == (isBackward ? focusNode : anchorNode)
      let isLast = textNode == (isBackward ? anchorNode : focusNode)
      var startOffset = 0
      var endOffset: Int?

      if isSame {
        startOffset = anchorOffset > focusOffset ? focusOffset : anchorOffset
        endOffset = anchorOffset > focusOffset ? anchorOffset : focusOffset
      } else if isFirst {
        let offset = isBackward ? focusOffset : anchorOffset
        startOffset = offset
        endOffset = nil
      } else if isLast {
        let offset = isBackward ? anchorOffset : focusOffset
        startOffset = 0
        endOffset = offset
      }

      let text = textNode.getText_dangerousPropertyAccess() as NSString
      let length = text.length - startOffset - (text.length - (endOffset ?? text.length))

      let range = NSRange(location: startOffset, length: length)
      let subString = text.substring(with: range)
      textNode.setText_dangerousPropertyAccess(String(subString))
      return textNode
    }
  }
  return textNode
}

public func decoratorView(forKey key: NodeKey, createIfNecessary: Bool) -> UIView? {
  guard let editor = getActiveEditor() else {
    return nil
  }

  guard let cacheItem = editor.decoratorCache[key] else {
    editor.log(.editor, .warning, "Requested decorator view for a node not in the cache")
    return nil
  }

  switch cacheItem {
  case .needsCreation:
    guard let node = getNodeByKey(key: key) as? DecoratorNode else {
      editor.log(.editor, .warning, "Requested decorator view for a node that is not a decorator node")
      return nil
    }
    let newView = node.createView()
    node.decorate(view: newView)
    editor.decoratorCache[key] = DecoratorCacheItem.unmountedCachedView(newView)
    editor.log(.editor, .verbose, "Creating view (and setting to unmounted): key \(key)")
    return newView
  case .cachedView(let view):
    editor.log(.editor, .verbose, "Returning cached view: key \(key)")
    return view
  case .unmountedCachedView(let view):
    editor.log(.editor, .verbose, "Returning unmounted cached view: key \(key)")
    return view
  case .needsDecorating(let view):
    editor.log(.editor, .verbose, "Returning needs decorating cached view: key \(key)")
    return view
  }
}

internal func destroyCachedDecoratorView(forKey key: NodeKey) {
  guard let editor = getActiveEditor() else {
    return
  }
  editor.decoratorCache.removeValue(forKey: key)
}

public typealias FindFunction = (
  _ node: Node
) -> Bool

public func findMatchingParent(startingNode: Node?, findFn: FindFunction) -> Node? {
  var currentNode: Node? = startingNode

  while let curr = currentNode, curr != getRoot() {
    if findFn(curr) {
      return curr
    }

    currentNode = curr.getParent()
  }

  return nil
}

/**
 *Returns the element node of the nearest ancestor, otherwise throws an error.
 * @param startNode - The starting node of the search
 * @returns The ancestor node found
 */
public func getNearestBlockElementAncestorOrThrow(startNode: Node) throws -> ElementNode {
  let blockNode = findMatchingParent(startingNode: startNode) { node in
    if let elementNode = node as? ElementNode {
      return !elementNode.isInline()
    }
    return false
  }

  guard let blockNode = blockNode as? ElementNode else {
    throw LexicalError.invariantViolation("expected node to have closest block element node")
  }

  return blockNode
}

public func applyNodeReplacement<N: Node>(
  node: N
) throws -> N {
  // TODO: Lexical iOS doesn't support node replacement yet
  return node as N
}

/**
 * Takes a node and traverses up its ancestors (toward the root node)
 * in order to find a specific type of node.
 * @param node - the node to begin searching.
 * @param klass - an instance of the type of node to look for.
 * @returns the node of type klass that was passed, or null if none exist.
 */
public func getNearestNodeOfType<T: ElementNode>(
  node: Node,
  type: NodeType
) -> T? {
  var parent: Node? = node

  while let unwrappedParent = parent {
    if unwrappedParent.type == type, let typedParent = unwrappedParent as? T {
      return typedParent as T
    }

    parent = unwrappedParent.getParent()
  }

  return nil
}

public func hasAncestor(
  child: Node,
  targetNode: Node
) -> Bool {
  var parent = child.getParent()
  while let unwrappedParent = parent {
    if unwrappedParent.isSameNode(targetNode) {
      return true
    }
    parent = unwrappedParent.getParent()
  }
  return false
}

public func maybeMoveChildrenSelectionToParent(
  parentNode: Node,
  offset: Int = 0
) throws -> BaseSelection? {
  if offset != 0 {
    throw LexicalError.invariantViolation("TODO")
  }
  let selection = try getSelection()
  guard let selection = selection as? RangeSelection, let parentNode = parentNode as? ElementNode else {
    // Only works on range selection
    return selection
  }
  let anchorNode = try selection.anchor.getNode()
  let focusNode = try selection.focus.getNode()
  if hasAncestor(child: anchorNode, targetNode: parentNode) {
    selection.anchor.updatePoint(key: parentNode.getKey(), offset: 0, type: .element)
  }
  if hasAncestor(child: focusNode, targetNode: parentNode) {
    selection.focus.updatePoint(key: parentNode.getKey(), offset: 0, type: .element)
  }
  return selection
}

public func getAttributedStringFromFrontend() throws -> NSAttributedString {
  // @alexmattice - replace this with a version driven off a depth first search
  guard let editor = getActiveEditor() else { return NSAttributedString(string: "") }

  let selection = editor.getNativeSelection()

  if let range = selection.range, let textStorage = editor.textStorage {
    return textStorage.attributedSubstring(from: range)
  } else {
    return NSAttributedString(string: "")
  }
}

public func removeFromParent(node: Node) throws {
  guard let writableParent = try node.getParent()?.getWritable() else {
    return
  }

  internallyMarkSiblingsAsDirty(node: node, status: .userInitiated)

  writableParent.children.removeAll { childKey in
    childKey == node.getKey()
  }

  internallyMarkNodeAsDirty(node: writableParent)
}

private func resolveElement(
  element: ElementNode,
  isBackward: Bool,
  focusOffset: Int
) -> Node? {
  let parent = element.getParent()
  var offset = focusOffset
  var block = element
  if let parent {
    if isBackward, focusOffset == 0, let indexWithinParent = block.getIndexWithinParent() {
      offset = indexWithinParent
      block = parent
    } else if !isBackward, focusOffset == block.getChildrenSize(), let indexWithinParent = block.getIndexWithinParent() {
      offset = indexWithinParent + 1
      block = parent
    }
  }
  return block.getChildAtIndex(index: isBackward ? offset - 1 : offset)
}

public func getAdjacentNode(
  focus: Point,
  isBackward: Bool
) throws -> Node? {
  let focusOffset = focus.offset
  if focus.type == .element, let focusElement = try focus.getNode() as? ElementNode {
    return resolveElement(element: focusElement, isBackward: isBackward, focusOffset: focusOffset)
  } else {
    let focusNode = try focus.getNode()
    if (isBackward && focusOffset == 0) || (!isBackward && focusOffset == focusNode.getTextContentSize()) {
      let possibleNode =
        isBackward
        ? focusNode.getPreviousSibling()
        : focusNode.getNextSibling()

      guard let possibleNode else {
        return resolveElement(
          element: try focusNode.getParentOrThrow(),
          isBackward: isBackward,
          focusOffset: (focusNode.getIndexWithinParent() ?? 0) + (isBackward ? 0 : 1)
        )
      }
      return possibleNode
    }
  }
  return nil
}

public func setSelection(_ selection: BaseSelection?) throws {
  try errorOnReadOnly()
  let editorState = getActiveEditorState()
  selection?.dirty = true
  editorState?.selection = selection
}
