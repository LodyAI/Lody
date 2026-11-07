/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

/*
 * This file, Mutations, contains the logic for Lexical's `non-controlled` mode. In this mode,
 * the UITextView directly updates its text storage with newly typed characters, and then we
 * read them back and update the Lexical data model afterwards.
 */

var isProcessingMutations = false

// called when some text has already been changed in non-controlled mode. Note that in this
// state, the Range Cache is not in sync with the Attributed String. (The Range Cache _is_ in
// sync with the EditorState.)
// This method should only be called if we've already decided that it's OK to operate in
// non-controlled mode, i.e. the mutation doesn't delete across node boundaries or insert
// somewhere that is without a TextNode.
internal func handleTextMutation(textStorage: TextStorage, rangeOfChange: NSRange, lengthDelta: Int) throws {
  guard let editor = getActiveEditor()
  else {
    throw LexicalError.invariantViolation("Failed to find editor")
  }
  editor.log(.other, .verbose)

  guard let point = try pointAtStringLocation(rangeOfChange.location, searchDirection: .forward, rangeCache: editor.rangeCache) else {
    editor.log(.other, .verbose, "Failed to find node")
    throw LexicalError.invariantViolation("Failed to find node")
  }

  let nodeKey = point.key
  guard let editorState = getActiveEditorState(),
    let rangeCacheItem = editor.rangeCache[nodeKey],
    let node = getNodeByKey(key: nodeKey) as? TextNode,
    editor.dirtyNodes.isEmpty
  else {
    editor.log(.other, .verbose, "Failed to find node 2")
    throw LexicalError.invariantViolation("Failed to find node")
  }

  editor.log(.other, .verbose, "Before setting text: dirty nodes count \(editor.dirtyNodes.count)")

  let oldRange = rangeCacheItem.textRange()
  let newRange = NSRange(location: oldRange.location, length: oldRange.length + lengthDelta)

  if newRange.location + newRange.length <= textStorage.length {
    let text = textStorage.attributedSubstring(from: newRange).string

    // since we're updating from text view content, we also have to modify the range cache
    // without running the reconciler.
    try node.setText(text)
  } else {
    throw LexicalError.invariantViolation("mutation out of bounds: possible incorrect usage of non-controlled mode")
  }

  editor.log(.other, .verbose, "Before updating range cache: dirty nodes count \(editor.dirtyNodes.count)")

  updateRangeCacheForTextChange(nodeKey: nodeKey, delta: lengthDelta)

  editor.log(.other, .verbose, "After updating range cache: dirty nodes count \(editor.dirtyNodes.count)")

  // ensure correct attributes are in the UITextView
  // (Needed because UITextView doesn't propagate our custom attributes when inserting text)
  let styles = AttributeUtils.attributedStringStyles(from: node, state: editorState, theme: editor.getTheme())
  textStorage.setAttributes(styles, range: newRange)

  editor.log(.other, .verbose, "End of method: dirty nodes count \(editor.dirtyNodes.count)")
}

public func getIsProcessingMutations() -> Bool {
  return isProcessingMutations
}
