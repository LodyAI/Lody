/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

public enum NodePart {
  case preamble
  case text
  case postamble
}

private struct ReconcilerInsertion {
  var location: Int
  var nodeKey: NodeKey
  var part: NodePart
}

private final class ReconcilerState {
  internal init(
    currentEditorState: EditorState,
    pendingEditorState: EditorState,
    rangeCache: [NodeKey: RangeCacheItem],
    dirtyNodes: DirtyNodeMap,
    treatAllNodesAsDirty: Bool,
    markedTextOperation: MarkedTextOperation?
  ) {
    self.prevEditorState = currentEditorState
    self.nextEditorState = pendingEditorState
    self.prevRangeCache = rangeCache
    self.nextRangeCache = rangeCache // Use the previous range cache as a starting point
    self.locationCursor = 0
    self.rangesToDelete = []
    self.rangesToAdd = []
    self.dirtyNodes = dirtyNodes
    self.treatAllNodesAsDirty = treatAllNodesAsDirty
    self.markedTextOperation = markedTextOperation
    self.possibleDecoratorsToRemove = []
    self.decoratorsToAdd = []
    self.decoratorsToDecorate = []
  }

  let prevEditorState: EditorState
  let nextEditorState: EditorState
  let prevRangeCache: [NodeKey: RangeCacheItem]
  var nextRangeCache: [NodeKey: RangeCacheItem]
  var locationCursor: Int = 0
  var rangesToDelete: [NSRange]
  var rangesToAdd: [ReconcilerInsertion]
  let dirtyNodes: DirtyNodeMap
  let treatAllNodesAsDirty: Bool
  let markedTextOperation: MarkedTextOperation?
  var possibleDecoratorsToRemove: [NodeKey]
  var decoratorsToAdd: [NodeKey]
  var decoratorsToDecorate: [NodeKey]
}

/* Marked text is a difficult operation because it depends on us being in sync with some private state that
 * is held by the iOS keyboard. We can't set or read that state, so we have to make sure we do the things
 * that the keyboard is expecting.
 */
internal struct MarkedTextOperation {

  let createMarkedText: Bool
  let selectionRangeToReplace: NSRange
  let markedTextString: String
  let markedTextInternalSelection: NSRange
}

internal enum Reconciler {

  internal static func updateEditorState(
    currentEditorState: EditorState,
    pendingEditorState: EditorState,
    editor: Editor,
    shouldReconcileSelection: Bool, // the situations where we would want to not do this include handling non-controlled mode
    markedTextOperation: MarkedTextOperation?
  ) throws {
    editor.log(.reconciler, .verbose)

    guard let textStorage = editor.textStorage else {
      fatalError("Cannot run reconciler on an editor with no text storage")
    }

    if editor.dirtyNodes.isEmpty,
      editor.dirtyType == .noDirtyNodes,
      let currentSelection = currentEditorState.selection,
      let pendingSelection = pendingEditorState.selection,
      currentSelection.isSelection(pendingSelection),
      !pendingSelection.dirty,
      markedTextOperation == nil
    {
      // should be nothing to reconcile
      return
    }

    if let markedTextOperation, markedTextOperation.createMarkedText {
      guard !shouldReconcileSelection else {
        editor.log(.reconciler, .warning, "should not reconcile selection whilst starting marked text!")
        throw LexicalError.invariantViolation("should not reconcile selection whilst starting marked text!")
      }
    }

    let currentSelection = currentEditorState.selection
    let nextSelection = pendingEditorState.selection
    let needsUpdate = editor.dirtyType != .noDirtyNodes

    let reconcilerState = ReconcilerState(
      currentEditorState: currentEditorState,
      pendingEditorState: pendingEditorState,
      rangeCache: editor.rangeCache,
      dirtyNodes: editor.dirtyNodes,
      treatAllNodesAsDirty: editor.dirtyType == .fullReconcile,
      markedTextOperation: markedTextOperation)

    try reconcileNode(key: kRootNodeKey, reconcilerState: reconcilerState)

    let previousMode = textStorage.mode
    textStorage.mode = .controllerMode
    textStorage.beginEditing()

    editor.log(.reconciler, .verbose, "about to do rangesToDelete: total \(reconcilerState.rangesToDelete.count)")
    var nonEmptyDeletionsCount = 0

    for deletionRange in reconcilerState.rangesToDelete.reversed() {
      if deletionRange.length > 0 {
        nonEmptyDeletionsCount += 1
        editor.log(.reconciler, .verboseIncludingUserContent, "deleting range \(NSStringFromRange(deletionRange)) `\((textStorage.string as NSString).substring(with: deletionRange))`")
        textStorage.deleteCharacters(in: deletionRange)
      }
    }

    editor.log(.reconciler, .verbose, "did rangesToDelete: non-empty \(nonEmptyDeletionsCount)")

    var markedTextAttributedString: NSAttributedString?
    var markedTextPointForAddition: Point?

    if let markedTextOperation {
      // Find the Point corresponding to the location where marked text will be added
      markedTextPointForAddition = try? pointAtStringLocation(
        markedTextOperation.selectionRangeToReplace.location,
        searchDirection: .forward,
        rangeCache: reconcilerState.nextRangeCache
      )
    }

    // Handle the decorators
    let decoratorsToRemove = reconcilerState.possibleDecoratorsToRemove.filter { key in
      return !reconcilerState.decoratorsToAdd.contains(key)
    }
    let decoratorsToDecorate = reconcilerState.decoratorsToDecorate.filter { key in
      return !reconcilerState.decoratorsToAdd.contains(key)
    }
    decoratorsToRemove.forEach { key in
      decoratorView(forKey: key, createIfNecessary: false)?.removeFromSuperview()
      destroyCachedDecoratorView(forKey: key)
      textStorage.decoratorPositionCache[key] = nil
    }
    reconcilerState.decoratorsToAdd.forEach { key in
      if editor.decoratorCache[key] == nil {
        editor.decoratorCache[key] = DecoratorCacheItem.needsCreation
      }
      guard let rangeCacheItem = reconcilerState.nextRangeCache[key] else { return }
      textStorage.decoratorPositionCache[key] = rangeCacheItem.location
    }
    decoratorsToDecorate.forEach { key in
      if let cacheItem = editor.decoratorCache[key], let view = cacheItem.view {
        editor.decoratorCache[key] = DecoratorCacheItem.needsDecorating(view)
      }
      guard let rangeCacheItem = reconcilerState.nextRangeCache[key] else { return }
      textStorage.decoratorPositionCache[key] = rangeCacheItem.location
    }

    editor.log(.reconciler, .verbose, "about to do rangesToAdd: total \(reconcilerState.rangesToAdd.count)")

    var nonEmptyRangesToAddCount = 0
    var rangesInserted: [NSRange] = []
    for insertion in reconcilerState.rangesToAdd {
      let attributedString = attributedStringFromInsertion(
        insertion,
        state: reconcilerState.nextEditorState,
        theme: editor.getTheme())
      if attributedString.length > 0 {
        nonEmptyRangesToAddCount += 1
        editor.log(.reconciler, .verboseIncludingUserContent, "inserting at \(insertion.location), `\(attributedString.string)`")
        textStorage.insert(attributedString, at: insertion.location)
        rangesInserted.append(NSRange(location: insertion.location, length: attributedString.length))

        // If this insertion corresponds to the marked text location, keep hold of the attributed string.
        if let pointForAddition = markedTextPointForAddition, let length = markedTextOperation?.markedTextString.lengthAsNSString() {
          if insertion.part == .text && pointForAddition.key == insertion.nodeKey && pointForAddition.offset + length <= attributedString.length {
            markedTextAttributedString = attributedString
          }
        }
      }
    }

    // Fix up all attributes afterwards. Doing the fix during the insertion loop above will cause incorrect normalisation of NSParagraphStyles.
    for range in rangesInserted {
      textStorage.fixAttributes(in: range)
    }

    editor.log(.reconciler, .verbose, "did rangesToAdd: non-empty \(nonEmptyRangesToAddCount)")

    // BLOCK LEVEL ATTRIBUTES

    let lastDescendentAttributes = getRoot()?.getLastChild()?.getAttributedStringAttributes(theme: editor.getTheme())

    // TODO: this iteration applies the attributes in an arbitrary order. If we are to handle nesting nodes with these block level attributes
    // we may want to apply them in a deterministic order, and also make them nest additively (i.e. for when two blocks start at the same paragraph)
    var nodesToApplyBlockAttributes: Set<NodeKey> = []
    if reconcilerState.treatAllNodesAsDirty {
      nodesToApplyBlockAttributes = Set(pendingEditorState.nodeMap.keys)
    } else {
      for nodeKey in reconcilerState.dirtyNodes.keys {
        guard let node = getNodeByKey(key: nodeKey) else { continue }
        nodesToApplyBlockAttributes.insert(nodeKey)
        for parentNodeKey in node.getParentKeys() {
          nodesToApplyBlockAttributes.insert(parentNodeKey)
        }
      }
    }
    let rangeCache = reconcilerState.nextRangeCache
    for nodeKey in nodesToApplyBlockAttributes {
      guard let node = getNodeByKey(key: nodeKey),
        node.isAttached(),
        let cacheItem = rangeCache[nodeKey],
        let attributes = node.getBlockLevelAttributes(theme: editor.getTheme())
      else { continue }

      AttributeUtils.applyBlockLevelAttributes(attributes, cacheItem: cacheItem, textStorage: textStorage, nodeKey: nodeKey, lastDescendentAttributes: lastDescendentAttributes ?? [:])
    }

    editor.rangeCache = reconcilerState.nextRangeCache
    textStorage.endEditing()
    textStorage.mode = previousMode

    if let markedTextOperation,
      markedTextOperation.createMarkedText,
      let markedTextAttributedString,
      let startPoint = markedTextPointForAddition,
      let frontend = editor.frontend
    {
      // We have a marked text operation, an attributed string, we know the Point at which it should be added.
      // Note that the text has _already_ been inserted into the TextStorage, so we actually have to _replace_ the
      // marked text range with the same text, but via a marked text operation. Hence we deduce the end point
      // of the marked text, set a fake selection using it, and then tell the text view to go ahead and start a
      // marked text operation.
      let length = markedTextOperation.markedTextString.lengthAsNSString()
      let endPoint = Point(key: startPoint.key, offset: startPoint.offset + length, type: .text)
      try frontend.updateNativeSelection(from: RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat()))
      let attributedSubstring = markedTextAttributedString.attributedSubstring(from: NSRange(location: startPoint.offset, length: length))
      editor.frontend?.setMarkedTextFromReconciler(attributedSubstring, selectedRange: markedTextOperation.markedTextInternalSelection)

      // do not do selection reconcile after marked text!
      // The selection will be correctly set as part of the setMarkedTextFromReconciler() call.
      return
    }

    var selectionsAreDifferent = false
    if let nextSelection, let currentSelection {
      let isSame = nextSelection.isSelection(currentSelection)
      selectionsAreDifferent = !isSame
    }

    if shouldReconcileSelection && (needsUpdate || nextSelection == nil || selectionsAreDifferent) {
      try reconcileSelection(prevSelection: currentSelection, nextSelection: nextSelection, editor: editor)
    }
  }

  private static func reconcileNode(key: NodeKey, reconcilerState: ReconcilerState) throws {
    guard let prevNode = reconcilerState.prevEditorState.nodeMap[key], let nextNode = reconcilerState.nextEditorState.nodeMap[key] else {
      throw LexicalError.invariantViolation(
        "reconcileNode should only be called when a node is present in both node maps, otherwise create or delete should be called")
    }
    guard let prevRange = reconcilerState.prevRangeCache[key] else {
      throw LexicalError.invariantViolation(
        "Node map entry for '\(key)' not found")
    }

    let isDirty = reconcilerState.dirtyNodes[key] != nil || reconcilerState.treatAllNodesAsDirty

    if prevNode === nextNode && !isDirty {
      if prevRange.location != reconcilerState.locationCursor {
        // we only have to update the location of this and children; all other cache values are valid
        // NB, the updateLocationOfNonDirtyNode method handles updating the reconciler state location cursor
        updateLocationOfNonDirtyNode(key: key, reconcilerState: reconcilerState)
      } else {
        // cache is already valid, just update the cursor
        // no need to iterate into children, since their cache values are valid too and we've got a cached childrenLength we can use.
        reconcilerState.locationCursor += prevRange.preambleLength + prevRange.textLength + prevRange.childrenLength + prevRange.postambleLength
      }
      return
    }

    var nextRangeCacheItem = RangeCacheItem()
    nextRangeCacheItem.location = reconcilerState.locationCursor

    let nextPreambleLength = nextNode.getPreamble().lengthAsNSString()
    createAddRemoveRanges(
      key: key,
      prevLocation: prevRange.location,
      prevLength: prevRange.preambleLength,
      nextLength: nextPreambleLength,
      reconcilerState: reconcilerState,
      part: .preamble
    )
    nextRangeCacheItem.preambleLength = nextPreambleLength

    // right, now we have finished the preamble, and the cursor is in the right place. Time for children.
    if nextNode is ElementNode {
      let cursorBeforeChildren = reconcilerState.locationCursor
      try reconcileChildren(key: key, reconcilerState: reconcilerState)
      nextRangeCacheItem.childrenLength = reconcilerState.locationCursor - cursorBeforeChildren
    } else if nextNode is DecoratorNode {
      reconcilerState.decoratorsToDecorate.append(key)
    }

    let nextTextLength = nextNode.getTextPart().lengthAsNSString()
    createAddRemoveRanges(
      key: key,
      prevLocation: prevRange.location + prevRange.preambleLength + prevRange.childrenLength,
      prevLength: prevRange.textLength,
      nextLength: nextTextLength,
      reconcilerState: reconcilerState,
      part: .text
    )
    nextRangeCacheItem.textLength = nextTextLength

    let nextPostambleLength = nextNode.getPostamble().lengthAsNSString()
    createAddRemoveRanges(
      key: key,
      prevLocation: prevRange.location + prevRange.preambleLength + prevRange.childrenLength + prevRange.textLength,
      prevLength: prevRange.postambleLength,
      nextLength: nextPostambleLength,
      reconcilerState: reconcilerState,
      part: .postamble
    )
    nextRangeCacheItem.postambleLength = nextPostambleLength

    reconcilerState.nextRangeCache[key] = nextRangeCacheItem
  }

  private static func createAddRemoveRanges(
    key: NodeKey,
    prevLocation: Int,
    prevLength: Int,
    nextLength: Int,
    reconcilerState: ReconcilerState,
    part: NodePart
  ) {
    if prevLength > 0 {
      let prevRange = NSRange(location: prevLocation, length: prevLength)
      reconcilerState.rangesToDelete.append(prevRange)
    }
    if nextLength > 0 {
      let insertion = ReconcilerInsertion(location: reconcilerState.locationCursor, nodeKey: key, part: part)
      reconcilerState.rangesToAdd.append(insertion)
    }
    reconcilerState.locationCursor += nextLength
  }

  private static func createNode(key: NodeKey, reconcilerState: ReconcilerState) {
    guard let nextNode = reconcilerState.nextEditorState.nodeMap[key] else {
      return
    }

    var nextRangeCacheItem = RangeCacheItem()
    nextRangeCacheItem.location = reconcilerState.locationCursor

    let nextPreambleLength = nextNode.getPreamble().lengthAsNSString()
    let preambleInsertion = ReconcilerInsertion(location: reconcilerState.locationCursor, nodeKey: key, part: .preamble)
    reconcilerState.rangesToAdd.append(preambleInsertion)
    reconcilerState.locationCursor += nextPreambleLength
    nextRangeCacheItem.preambleLength = nextPreambleLength

    if let nextNode = nextNode as? ElementNode, !nextNode.children.isEmpty {
      let cursorBeforeChildren = reconcilerState.locationCursor
      createChildren(nextNode.children, range: 0...nextNode.children.count - 1, reconcilerState: reconcilerState)
      nextRangeCacheItem.childrenLength = reconcilerState.locationCursor - cursorBeforeChildren
    } else if nextNode is DecoratorNode {
      reconcilerState.decoratorsToAdd.append(key)
    }

    let nextTextLength = nextNode.getTextPart().lengthAsNSString()
    let textInsertion = ReconcilerInsertion(location: reconcilerState.locationCursor, nodeKey: key, part: .text)
    reconcilerState.rangesToAdd.append(textInsertion)
    reconcilerState.locationCursor += nextTextLength
    nextRangeCacheItem.textLength = nextTextLength

    let nextPostambleLength = nextNode.getPostamble().lengthAsNSString()
    let postambleInsertion = ReconcilerInsertion(location: reconcilerState.locationCursor, nodeKey: key, part: .postamble)
    reconcilerState.rangesToAdd.append(postambleInsertion)
    reconcilerState.locationCursor += nextPostambleLength
    nextRangeCacheItem.postambleLength = nextPostambleLength

    reconcilerState.nextRangeCache[key] = nextRangeCacheItem
  }

  private static func destroyNode(key: NodeKey, reconcilerState: ReconcilerState) {
    guard let prevNode = reconcilerState.prevEditorState.nodeMap[key], let prevRangeCacheItem = reconcilerState.prevRangeCache[key] else {
      return
    }

    let prevPreambleRange = NSRange(location: prevRangeCacheItem.location, length: prevRangeCacheItem.preambleLength)
    reconcilerState.rangesToDelete.append(prevPreambleRange)

    if let prevNode = prevNode as? ElementNode, !prevNode.children.isEmpty {
      destroyChildren(prevNode.children, range: 0...prevNode.children.count - 1, reconcilerState: reconcilerState)
    } else if prevNode is DecoratorNode {
      reconcilerState.possibleDecoratorsToRemove.append(key)
    }

    let prevTextRange = NSRange(location: prevRangeCacheItem.location + prevRangeCacheItem.preambleLength + prevRangeCacheItem.childrenLength, length: prevRangeCacheItem.textLength)
    reconcilerState.rangesToDelete.append(prevTextRange)

    let prevPostambleRange = NSRange(location: prevRangeCacheItem.location + prevRangeCacheItem.preambleLength + prevRangeCacheItem.childrenLength + prevRangeCacheItem.textLength, length: prevRangeCacheItem.postambleLength)
    reconcilerState.rangesToDelete.append(prevPostambleRange)

    if reconcilerState.nextEditorState.nodeMap[key] == nil {
      reconcilerState.nextRangeCache.removeValue(forKey: key)
    }
  }

  private static func reconcileChildren(key: NodeKey, reconcilerState: ReconcilerState) throws {
    guard let prevNode = reconcilerState.prevEditorState.nodeMap[key] as? ElementNode,
      let nextNode = reconcilerState.nextEditorState.nodeMap[key] as? ElementNode
    else {
      return
    }
    // in JS, this method does a few optimisation codepaths, then calls to the slow path reconcileNodeChildren. I'll not program the optimisations yet.
    try reconcileNodeChildren(
      prevChildren: prevNode.children,
      nextChildren: nextNode.children,
      prevChildrenLength: prevNode.children.count,
      nextChildrenLength: nextNode.children.count,
      reconcilerState: reconcilerState)
  }

  private static func reconcileNodeChildren(
    prevChildren: [NodeKey],
    nextChildren: [NodeKey],
    prevChildrenLength: Int,
    nextChildrenLength: Int,
    reconcilerState: ReconcilerState
  ) throws {
    let prevEndIndex = prevChildrenLength - 1
    let nextEndIndex = nextChildrenLength - 1
    var prevIndex = 0
    var nextIndex = 0

    // the sets exist as an optimisation for performance reasons
    var prevChildrenSet: Set<NodeKey>?
    var nextChildrenSet: Set<NodeKey>?

    while prevIndex <= prevEndIndex && nextIndex <= nextEndIndex {
      let prevKey = prevChildren[prevIndex]
      let nextKey = nextChildren[nextIndex]

      if prevKey == nextKey {
        try reconcileNode(key: nextKey, reconcilerState: reconcilerState)
        prevIndex += 1
        nextIndex += 1
      } else {
        if prevChildrenSet == nil {
          prevChildrenSet = Set(prevChildren)
        }
        if nextChildrenSet == nil {
          nextChildrenSet = Set(nextChildren)
        }

        let nextHasPrevKey = nextChildren.contains(prevKey)
        let prevHasNextKey = prevChildren.contains(nextKey)

        if !nextHasPrevKey {
          // Remove prev
          destroyNode(key: prevKey, reconcilerState: reconcilerState)
          prevIndex += 1
        } else if !prevHasNextKey {
          // Create next
          createNode(key: nextKey, reconcilerState: reconcilerState)
          nextIndex += 1
        } else {
          // Move next -- destroy old and then insert new. (The counterpart will occur later in the loop!)
          destroyNode(key: prevKey, reconcilerState: reconcilerState)
          createNode(key: nextKey, reconcilerState: reconcilerState)
          prevIndex += 1
          nextIndex += 1
        }
      }
    }

    let appendNewChildren = prevIndex > prevEndIndex
    let removeOldChildren = nextIndex > nextEndIndex

    if appendNewChildren && !removeOldChildren {
      createChildren(nextChildren, range: nextIndex...nextEndIndex, reconcilerState: reconcilerState)
    } else if removeOldChildren && !appendNewChildren {
      destroyChildren(prevChildren, range: prevIndex...prevEndIndex, reconcilerState: reconcilerState)
    }
  }

  private static func createChildren(_ children: [NodeKey], range: ClosedRange<Int>, reconcilerState: ReconcilerState) {
    for child in children[range] {
      createNode(key: child, reconcilerState: reconcilerState)
    }
  }

  private static func destroyChildren(_ children: [NodeKey], range: ClosedRange<Int>, reconcilerState: ReconcilerState) {
    for child in children[range] {
      destroyNode(key: child, reconcilerState: reconcilerState)
    }
  }

  private static func updateLocationOfNonDirtyNode(key: NodeKey, reconcilerState: ReconcilerState) {
    // not a typo that I'm setting nextRangeCacheItem to prevRangeCache[key]. We want to start with the prev cache item and update it.
    guard var nextRangeCacheItem = reconcilerState.prevRangeCache[key], let nextNode = reconcilerState.nextEditorState.nodeMap[key] else {
      // expected range cache entry to already exist
      return
    }
    nextRangeCacheItem.location = reconcilerState.locationCursor
    reconcilerState.nextRangeCache[key] = nextRangeCacheItem

    reconcilerState.locationCursor += nextRangeCacheItem.preambleLength
    if let nextNode = nextNode as? ElementNode {
      for childNodeKey in nextNode.children {
        updateLocationOfNonDirtyNode(key: childNodeKey, reconcilerState: reconcilerState)
      }
    }

    reconcilerState.locationCursor += nextRangeCacheItem.textLength
    reconcilerState.locationCursor += nextRangeCacheItem.postambleLength
    return
  }

  private static func attributedStringFromInsertion(
    _ insertion: ReconcilerInsertion,
    state: EditorState,
    theme: Theme
  ) -> NSAttributedString {
    guard let node = state.nodeMap[insertion.nodeKey] else {
      return NSAttributedString()
    }

    var attributedString: NSAttributedString

    switch insertion.part {
    case .text:
      attributedString = NSAttributedString(string: node.getTextPart())
    case .preamble:
      attributedString = NSAttributedString(string: node.getPreamble())
    case .postamble:
      attributedString = NSAttributedString(string: node.getPostamble())
    }

    attributedString = AttributeUtils.attributedStringByAddingStyles(
      attributedString,
      from: node,
      state: state,
      theme: theme)

    return attributedString
  }

  private static func reconcileSelection(
    prevSelection: BaseSelection?,
    nextSelection: BaseSelection?,
    editor: Editor
  ) throws {
    guard let nextSelection else {
      if let prevSelection {
        if !prevSelection.dirty {
          return
        }

        editor.frontend?.resetSelectedRange()
      }

      return
    }

    // TODO: if node selection, go tell decorator nodes to select themselves!

    try editor.frontend?.updateNativeSelection(from: nextSelection)
  }
}

internal func performReconcilerSanityCheck(
  editor sanityCheckEditor: Editor,
  expectedOutput: NSAttributedString
) throws {
  // TODO @amyworrall: this was commented out during the Frontend refactor. Create a new Frontend that contains
  // a TextKit stack but no selection or UI. Use that to re-implement the reconciler.

  //    // create new editor to reconcile within
  //    let editor = Editor(
  //      featureFlags: FeatureFlags(reconcilerSanityCheck: false),
  //      editorConfig: EditorConfig(theme: sanityCheckEditor.getTheme(), plugins: []))
  //    editor.textStorage = TextStorage()
  //
  //    try editor.setEditorState(sanityCheckEditor.getEditorState())
  //
  //    if let textStorage = editor.textStorage, !expectedOutput.isEqual(to: textStorage) {
  //      throw LexicalError.sanityCheck(
  //        errorMessage: "Failed sanity check",
  //        textViewText: expectedOutput.string,
  //        fullReconcileText: textStorage.string)
  //    }
}
