/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

func createPoint(key: NodeKey, offset: Int, type: SelectionType) -> Point {
  Point(key: key, offset: offset, type: type)
}

func selectPointOnNode(point: Point, node: Node) {
  var updatedOffset = point.offset

  if let textNode = node as? TextNode {
    let textContentLength = textNode.getTextPart().lengthAsNSString()

    if point.offset > textContentLength {
      updatedOffset = textContentLength
    }
  }

  point.updatePoint(key: node.key, offset: updatedOffset, type: point.type)
}

/// Returns the current Lexical selection, generating it from the UITextView if necessary.
/// - Parameters:
///   - allowInvalidPositions: In most cases, it is desirable to regenerate the selection whenever
///   the current selection does not refer to valid positions in valid nodes. However, there are some
///   situations, such as if you're getting the selection when preparing to modify it to be valid using your
///   own validity rules, when you just want to fetch the current selection whatever it is.
public func getSelection(allowInvalidPositions: Bool = false) throws -> BaseSelection? {
  let editorState = getActiveEditorState()
  let selection = editorState?.selection

  if let selection {
    if allowInvalidPositions == true {
      return selection
    }
    if sanityCheckSelection(selection) {
      return selection
    }
    getActiveEditor()?.log(.other, .warning, "Selection failed sanity check")
  }

  if let editor = getActiveEditor() {
    do {
      let selection = try createSelection(editor: editor)
      editorState?.selection = selection
      return selection
    } catch {
      editor.log(.other, .warning, "Exception while creating range selection")
      return nil
    }
  }

  // Could not get active editor. This is unexpected, but we can't log since logging requires editor!
  throw LexicalError.invariantViolation("called getSelection() without an active editor")
}

private func sanityCheckSelection(_ selection: BaseSelection) -> Bool {
  guard let selection = selection as? RangeSelection else {
    // no sanity checking on other selection types yet
    return true
  }

  let anchor = selection.anchor
  let focus = selection.focus

  if sanityCheckPoint(anchor) && sanityCheckPoint(focus) {
    return true
  }

  return false
}

private func sanityCheckPoint(_ point: Point) -> Bool {
  guard let node = getNodeByKey(key: point.key) else {
    return false
  }
  if point.type == .text {
    guard let node = node as? TextNode else {
      return false
    }
    let text = node.getText_dangerousPropertyAccess()
    guard point.offset <= text.lengthAsNSString() else {
      return false
    }
    return true
  } else if point.type == .element {
    guard let node = node as? ElementNode else {
      return false
    }
    guard point.offset <= node.getChildrenSize() else {
      return false
    }
    return true
  }
  getActiveEditor()?.log(.other, .error, "Points that are not text or element have not yet been implemented")
  return false
}

func adjustPointOffsetForMergedSibling(
  point: Point,
  isBefore: Bool,
  key: NodeKey,
  target: TextNode,
  textLength: Int
) {
  if point.type == .text {
    point.key = key
    if !isBefore {
      point.offset += textLength
    }
  } else if point.offset > target.getIndexWithinParent() ?? 0 {
    point.offset -= 1
  }
}

func moveSelectionPointToSibling(
  point: Point,
  node: Node,
  parent: ElementNode
) {
  var siblingKey: NodeKey?
  var offset = 0
  var type: SelectionType?

  if let prevSibling = node.getPreviousSibling() {
    siblingKey = prevSibling.key
    if let prevTextNode = prevSibling as? TextNode {
      offset = prevTextNode.getTextContentSize()
      type = .text
    } else if let prevElementNode = prevSibling as? ElementNode {
      offset = prevElementNode.getChildrenSize()
      type = .element
    }
  } else {
    if let nextSibling = node.getNextSibling() {
      siblingKey = nextSibling.key
      if isTextNode(nextSibling) {
        type = .text
      } else if isElementNode(node: nextSibling) {
        type = .element
      }
    }
  }

  if let siblingKey, let type {
    point.updatePoint(key: siblingKey, offset: offset, type: type)
  } else {
    if let offset = node.getIndexWithinParent() {
      point.updatePoint(key: parent.key, offset: offset, type: .element)
    } else {
      point.updatePoint(key: parent.key, offset: parent.getChildrenSize(), type: .element)
    }
  }
}

func editorStateHasDirtySelection(pendingEditorState: EditorState, editor: Editor) -> Bool {
  let currentSelection = editor.getEditorState().selection
  let pendingSelection = pendingEditorState.selection

  // Check if we need to update because of changes in selection
  if let pendingSelection {
    if pendingSelection.dirty {
      return true
    }
    if let currentSelection, !pendingSelection.isSelection(currentSelection) {
      return true
    }
  } else if currentSelection != nil {
    return true
  }

  return false
}

func stringLocationForPoint(_ point: Point, editor: Editor) throws -> Int? {
  let rangeCache = editor.rangeCache

  guard let rangeCacheItem = rangeCache[point.key] else { return nil }

  switch point.type {
  case .text:
    return rangeCacheItem.location + rangeCacheItem.preambleLength + point.offset
  case .element:
    guard let node = getNodeByKey(key: point.key) as? ElementNode else { return nil }

    let childrenKeys = node.getChildrenKeys()
    if point.offset > childrenKeys.count {
      return nil
    }

    if point.offset == childrenKeys.count {
      return rangeCacheItem.location + rangeCacheItem.preambleLength + rangeCacheItem.childrenLength
    }

    guard let childRangeCacheItem = rangeCache[childrenKeys[point.offset]] else { return nil }

    return childRangeCacheItem.location
  case .range:
    throw LexicalError.invariantViolation("Need range selection")
  case .node:
    throw LexicalError.invariantViolation("Need node selection")
  case .grid:
    throw LexicalError.invariantViolation("Need grid selection")
  }
}

public func createNativeSelection(from selection: RangeSelection, editor: Editor) throws -> NativeSelection {
  let isBefore = try selection.anchor.isBefore(point: selection.focus)
  var affinity: UITextStorageDirection = isBefore ? .forward : .backward

  if selection.anchor == selection.focus {
    affinity = .forward
  }

  guard let anchorLocation = try stringLocationForPoint(selection.anchor, editor: editor),
    let focusLocation = try stringLocationForPoint(selection.focus, editor: editor)
  else {
    return NativeSelection()
  }

  let location = isBefore ? anchorLocation : focusLocation

  return NativeSelection(
    range: NSRange(location: location, length: abs(anchorLocation - focusLocation)),
    affinity: affinity)
}

func createEmptyRangeSelection() -> RangeSelection {
  let anchor = Point(key: kRootNodeKey, offset: 0, type: .element)
  let focus = Point(key: kRootNodeKey, offset: 0, type: .element)

  return RangeSelection(anchor: anchor, focus: focus, format: TextFormat())
}

/// When we create a selection, we try to use the previous selection where possible, unless an actual user selection change has occurred.
/// When we do need to create a new selection, we validate we can have text nodes for both anchor and focus nodes.
/// If that holds true, we then return that selection as a mutable object that we use for the editor state for this update cycle.
/// If a selection gets changed, and requires a update to native iOS selection, it gets marked as "dirty".
/// If the selection changes, but matches with the existing native selection, then we only need to sync it.
/// Otherwise, we generally bail out of doing an update to selection during reconciliation unless there are dirty nodes that need reconciling.
func createSelection(editor: Editor) throws -> BaseSelection? {
  let currentEditorState = editor.getEditorState()
  let lastSelection = currentEditorState.selection

  guard let lastSelection else {
    let nativeSelection = editor.getNativeSelection()

    if nativeSelection.selectionIsNodeOrObject {
      // cannot derive selection out of the UI layer in this case!
      return nil
    }

    let range = nativeSelection.range ?? NSRange(location: 0, length: 0)

    if let anchor = try pointAtStringLocation(range.location, searchDirection: nativeSelection.affinity, rangeCache: editor.rangeCache),
      let focus = try pointAtStringLocation(range.location + range.length, searchDirection: nativeSelection.affinity, rangeCache: editor.rangeCache)
    {
      return RangeSelection(anchor: anchor, focus: focus, format: TextFormat())
    }

    return nil
  }

  // we have a last selection. Clone it!
  return lastSelection.clone()
}

/// This is used to make a selection when the existing selection is null or should be replaced,
/// i.e. forcing selection on the editor when it current exists outside the editor.
func makeRangeSelection(
  anchorKey: NodeKey,
  anchorOffset: Int,
  focusKey: NodeKey,
  focusOffset: Int,
  anchorType: SelectionType,
  focusType: SelectionType
) throws -> RangeSelection {
  guard let editorState = getActiveEditorState() else {
    throw LexicalError.internal("Editor state is nil")
  }

  let selection = RangeSelection(
    anchor: Point(key: anchorKey, offset: anchorOffset, type: anchorType),
    focus: Point(key: focusKey, offset: focusOffset, type: focusType),
    format: TextFormat())

  selection.dirty = true
  editorState.selection = selection

  return selection
}

func updateElementSelectionOnCreateDeleteNode(
  selection: RangeSelection,
  parentNode: Node,
  nodeOffset: Int,
  times: Int = 1
) throws {
  let anchor = selection.anchor
  let focus = selection.focus
  let anchorNode = try anchor.getNode()
  let focusNode = try focus.getNode()
  if parentNode != anchorNode && parentNode != focusNode {
    return
  }

  let parentKey = parentNode.getKey()
  // Single node. We shift selection but never redimension it
  if selection.isCollapsed() {
    let selectionOffset = anchor.offset
    if nodeOffset <= selectionOffset {
      let newSelectionOffset = max(0, selectionOffset + times)
      anchor.updatePoint(key: parentKey, offset: newSelectionOffset, type: .element)
      focus.updatePoint(key: parentKey, offset: newSelectionOffset, type: .element)
      // The new selection might point to text nodes, try to resolve them
      try updateSelectionResolveTextNodes(selection: selection)
    }

    return
  }
  // Multiple nodes selected. We shift or redimension selection
  let isBackward = try selection.isBackward()
  let firstPoint = isBackward ? focus : anchor
  let firstPointNode = try firstPoint.getNode()
  let lastPoint = isBackward ? anchor : focus
  let lastPointNode = try lastPoint.getNode()
  if parentNode == firstPointNode {
    let firstPointOffset = firstPoint.offset
    if nodeOffset <= firstPointOffset {
      firstPoint.updatePoint(key: parentKey, offset: max(0, firstPointOffset + times), type: .element)
    }
  }

  if parentNode == lastPointNode {
    let lastPointOffset = lastPoint.offset
    if nodeOffset <= lastPointOffset {
      lastPoint.updatePoint(key: parentKey, offset: max(0, lastPointOffset + times), type: .element)
    }
  }
  // The new selection might point to text nodes, try to resolve them
  try updateSelectionResolveTextNodes(selection: selection)
}

func updateSelectionResolveTextNodes(selection: RangeSelection) throws {
  let anchor = selection.anchor
  let anchorOffset = anchor.offset
  let focus = selection.focus
  let focusOffset = focus.offset
  let anchorNode = try anchor.getNode() as? ElementNode
  let focusNode = try focus.getNode() as? ElementNode

  if selection.isCollapsed() {
    if isElementNode(node: anchorNode) {
      return
    }

    guard let childSize = anchorNode?.getChildrenSize() else { return }
    let anchorOffsetAtEnd = anchorOffset >= childSize
    guard
      let child = anchorOffsetAtEnd
        ? anchorNode?.getChildAtIndex(index: childSize - 1)
        : anchorNode?.getChildAtIndex(index: anchorOffset)
    else {
      return
    }

    if isTextNode(child) {
      var newOffset = 0
      if anchorOffsetAtEnd {
        newOffset = child.getTextPartSize()
      }
      anchor.updatePoint(key: child.getKey(), offset: newOffset, type: .text)
      focus.updatePoint(key: child.getKey(), offset: newOffset, type: .text)
    }

    return
  }

  if isElementNode(node: anchorNode) {
    guard let childSize = anchorNode?.getChildrenSize() else { return }

    let anchorOffsetAtEnd = anchorOffset >= childSize

    guard
      let child = anchorOffsetAtEnd
        ? anchorNode?.getChildAtIndex(index: childSize - 1)
        : anchorNode?.getChildAtIndex(index: anchorOffset)
    else {
      return
    }

    if isTextNode(child) {
      var newOffset = 0
      if anchorOffsetAtEnd {
        newOffset = child.getTextPartSize()
      }

      anchor.updatePoint(key: child.getKey(), offset: newOffset, type: .text)
    }
  }

  if isElementNode(node: focusNode) {
    guard let childSize = focusNode?.getChildrenSize() else { return }

    let focusOffsetAtEnd = focusOffset >= childSize
    guard
      let child = focusOffsetAtEnd
        ? focusNode?.getChildAtIndex(index: childSize - 1)
        : focusNode?.getChildAtIndex(index: focusOffset)
    else {
      return
    }

    if isTextNode(child) {
      var newOffset = 0
      if focusOffsetAtEnd {
        newOffset = child.getTextPartSize()
      }

      focus.updatePoint(key: child.getKey(), offset: newOffset, type: .text)
    }
  }
}

func moveSelectionPointToEnd(point: Point, node: Node) {
  if let node = node as? ElementNode {
    let lastNode = node.getLastDescendant()

    if isElementNode(node: lastNode) || isTextNode(lastNode) {
      if let lastNode {
        selectPointOnNode(point: point, node: lastNode)
      }
    } else {
      selectPointOnNode(point: point, node: node)
    }
  } else if let node = node as? TextNode {
    selectPointOnNode(point: point, node: node)
  }
}

func transferStartingElementPointToTextPoint(start: Point, end: Point, format: TextFormat, style: String) throws {
  guard let element = try start.getNode() as? ElementNode else { return }

  var placementNode = element.getChildAtIndex(index: start.offset)
  let textNode = try createTextNode(text: nil).setFormat(format: format)
  var target: Node

  if isRootNode(node: element) {
    let newParagraphNode = ParagraphNode()
    try newParagraphNode.append([textNode])
    target = newParagraphNode
  } else {
    target = textNode
  }

  _ = try textNode.setFormat(format: format)

  if placementNode == nil {
    try element.append([target])
  } else {
    placementNode = try placementNode?.insertBefore(nodeToInsert: target)
    // fix the end point offset if it refers to the same element as start,
    // as we've now inserted another element before it.
    if end.type == .element && end.key == start.key {
      end.updatePoint(key: end.key, offset: end.offset + 1, type: .element)
    }
  }

  if start == end {
    end.updatePoint(key: textNode.getKey(), offset: 0, type: .text)
  }

  start.updatePoint(key: textNode.getKey(), offset: 0, type: .text)
}

func removeSegment(node: TextNode, isBackward: Bool, offset: Int) throws {
  let textNode = node
  let textContent = textNode.getTextContent(includeInert: false, includeDirectionless: true)
  var split: [String] =
    textContent
    .split(separator: " ")
    .enumerated()
    .map { String($0 > 0 ? " \($1)" : $1) }
  let splitLength = split.count
  var segmentOffset = 0
  var restoreOffset: Int?

  for (index, segment) in split.enumerated() {
    let isLastSegment = index == splitLength - 1
    restoreOffset = segmentOffset
    segmentOffset += segment.lengthAsNSString()

    if (isBackward && segmentOffset == offset) || segmentOffset > offset || isLastSegment {
      split.remove(at: index)
      if isLastSegment {
        restoreOffset = nil
      }
      break
    }
  }

  let nextTextContent =
    split
    .joined(separator: "")
    .trimmingCharacters(in: .whitespaces)

  if nextTextContent == "" {
    try textNode.remove()
  } else {
    try textNode.setText(nextTextContent)
    try textNode.select(anchorOffset: restoreOffset, focusOffset: restoreOffset)
  }
}

public func setBlocksType(
  selection: RangeSelection,
  createElement: () -> ElementNode
) {
  if selection.anchor.key == kRootNodeKey {
    let element = createElement()
    guard let root = getRoot() else { return }
    let firstChild = root.getFirstChild()

    if let firstChild {
      _ = try? firstChild.replace(replaceWith: element, includeChildren: true)
    } else {
      try? root.append([element])
    }

    return
  }

  var nodes = (try? selection.getNodes()) ?? []

  var currentNode: Node? = try? selection.anchor.getNode()
  while let currentNodeUnwrapped = currentNode {
    if !nodes.contains(currentNodeUnwrapped) {
      nodes.append(currentNodeUnwrapped)
    }
    currentNode = currentNodeUnwrapped.getParent()
  }

  for node in nodes {
    if !isBlock(node) {
      continue
    }

    let targetElement = createElement()
    if let node = node as? ElementNode {
      _ = try? targetElement.setIndent(node.getIndent())
    }
    _ = try? node.replace(replaceWith: targetElement, includeChildren: true)
  }
}

private func isBlock(_ node: Node) -> Bool {
  guard let node = node as? ElementNode, !isRootNode(node: node) else {
    return false
  }

  let firstChild = node.getFirstChild()
  let isLeafElement =
    firstChild == nil || isTextNode(firstChild) || ((firstChild as? ElementNode)?.isInline() ?? false)

  return !node.isInline() && node.canBeEmpty() != false && isLeafElement
}

private func resolveSelectionPointOnBoundary(
  point: Point,
  isBackward: Bool,
  isCollapsed: Bool
) throws {
  let offset = point.offset
  let node = try point.getNode()

  if offset == 0 {
    let prevSibling = node.getPreviousSibling()
    let parent = node.getParent()

    if !isBackward {
      if let prevSibling = prevSibling as? ElementNode,
        !isCollapsed,
        prevSibling.isInline()
      {
        point.key = prevSibling.key
        point.offset = prevSibling.getChildrenSize()
        point.type = .element
      } else if let prevSibling = prevSibling as? TextNode {
        point.key = prevSibling.key
        point.offset = prevSibling.getTextContent().lengthAsNSString()
      }
    } else if isCollapsed || !isBackward,
      prevSibling == nil,
      let parent,
      parent.isInline()
    {
      let parentSibling = parent.getPreviousSibling()
      if let parentSibling = parentSibling as? TextNode {
        point.key = parentSibling.key
        point.offset = parentSibling.getTextContent().lengthAsNSString()
      }
    }
  } else if offset == node.getTextContent().lengthAsNSString() {
    let nextSibling = node.getNextSibling()
    let parent = node.getParent()

    if isBackward, let nextSibling = nextSibling as? ElementNode, nextSibling.isInline() {
      point.key = nextSibling.key
      point.offset = 0
      point.type = .element
    } else if isCollapsed || isBackward,
      nextSibling == nil,
      let parent,
      parent.isInline(),
      !parent.canInsertTextAfter()
    {
      let parentSibling = parent.getNextSibling()
      if let parentSibling = parentSibling as? TextNode {
        point.key = parentSibling.key
        point.offset = 0
      }
    }
  }
}

internal func normalizeSelectionPointsForBoundaries(
  anchor: Point,
  focus: Point,
  lastSelection: BaseSelection?
) throws {
  if anchor.type == .text && focus.type == .text {
    let isBackward = try anchor.isBefore(point: focus)
    let isCollapsed = anchor == focus

    // Attempt to normalize the offset to the previous sibling if we're at the
    // start of a text node and the sibling is a text node or inline element.
    try resolveSelectionPointOnBoundary(point: anchor, isBackward: isBackward, isCollapsed: isCollapsed)
    try resolveSelectionPointOnBoundary(point: focus, isBackward: !isBackward, isCollapsed: isCollapsed)

    if isCollapsed {
      focus.key = anchor.key
      focus.offset = anchor.offset
      focus.type = anchor.type
    }
    guard let editor = getActiveEditor() else {
      throw LexicalError.invariantViolation("no editor")
    }

    if editor.isComposing(),
      editor.compositionKey != anchor.key,
      let lastSelection = lastSelection as? RangeSelection
    {
      let lastAnchor = lastSelection.anchor
      let lastFocus = lastSelection.focus
      anchor.key = lastAnchor.key
      anchor.type = lastAnchor.type
      anchor.offset = lastAnchor.offset
      focus.key = lastFocus.key
      focus.type = lastFocus.type
      focus.offset = lastFocus.offset
    }
  }
}
