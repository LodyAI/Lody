/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import Lexical
import UIKit

enum MergeAction {
  case historyMerge
  case historyPush
  case discardHistoryCandidate
}

enum ChangeType {
  case other
  case composingCharacter
  case insertCharacterAfterSelection
  case insertCharacterBeforeSelection
  case deleteCharacterBeforeSelection
  case deleteCharacterAfterSelection
}

public final class EditorHistory {
  weak var editor: Editor?
  var externalHistoryState: HistoryState?
  var delay: Int
  var prevChangeTime: Double
  var prevChangeType: ChangeType

  public init(editor: Editor, externalHistoryState: HistoryState, delay: Int = 5) {
    self.editor = editor
    self.externalHistoryState = externalHistoryState
    self.delay = delay
    self.prevChangeTime = 0
    self.prevChangeType = .other
  }

  public func applyChange(
    editorState: EditorState,
    prevEditorState: EditorState,
    dirtyNodes: DirtyNodeMap
  ) {
    guard let editor else {
      return
    }

    let historyState: HistoryState = externalHistoryState ?? createEmptyHistoryState()
    let currentEditorState = historyState.current == nil ? nil : historyState.current?.editorState

    if historyState.current != nil && editorState == currentEditorState {
      return
    }

    if historyState.current == nil {
      historyState.current = HistoryStateEntry(
        editor: editor,
        editorState: prevEditorState,
        undoSelection: prevEditorState.selection?.clone() as? RangeSelection)
    }

    do {
      let mergeAction = try getMergeAction(
        prevEditorState: prevEditorState,
        nextEditorState: editorState,
        currentHistoryEntry: historyState.current,
        dirtyNodes: dirtyNodes)

      if mergeAction == .historyPush {
        if !historyState.redoStack.isEmpty {
          historyState.redoStack = []
          editor.dispatchCommand(type: .canRedo, payload: false)
        }

        if let current = historyState.current, let editor = current.editor {
          historyState.undoStack.append(
            HistoryStateEntry(
              editor: editor,
              editorState: current.editorState,
              undoSelection: prevEditorState.selection?.clone() as? RangeSelection))
        }

        editor.dispatchCommand(type: .canUndo, payload: true)
      } else if mergeAction == .discardHistoryCandidate {
        return
      }

      historyState.current = HistoryStateEntry(
        editor: editor,
        editorState: editorState,
        undoSelection: editorState.selection?.clone() as? RangeSelection)

      externalHistoryState = historyState
    } catch {
      print("Failed to get mergeAction: \(error.localizedDescription)")
    }
  }

  func undo() {
    guard let externalHistoryState,
      !externalHistoryState.undoStack.isEmpty,
      let editor
    else { return }

    var historyStateEntry = externalHistoryState.undoStack.removeLast()
    if let current = externalHistoryState.current {
      externalHistoryState.redoStack.append(current)
      editor.dispatchCommand(type: .canRedo, payload: true)
    }

    if externalHistoryState.undoStack.isEmpty {
      editor.dispatchCommand(type: .canUndo, payload: false)
    }

    externalHistoryState.current = historyStateEntry
    do {
      if let editor = historyStateEntry.editor,
        let undoSelection = historyStateEntry.undoSelection
      {
        try editor.setEditorState(historyStateEntry.editorState.clone(selection: undoSelection))
        historyStateEntry.editor = editor
        editor.dispatchCommand(type: .updatePlaceholderVisibility)
      }
    } catch {
      editor.log(.other, .warning, "undo: Failed to setEditorState: \(error.localizedDescription)")
    }

    self.externalHistoryState = externalHistoryState
  }

  func redo() {
    guard let externalHistoryState,
      !externalHistoryState.redoStack.isEmpty,
      let editor
    else { return }

    if let current = externalHistoryState.current {
      externalHistoryState.undoStack.append(current)
      editor.dispatchCommand(type: .canUndo, payload: true)
    }

    let historyStateEntry = externalHistoryState.redoStack.removeLast()
    if externalHistoryState.redoStack.isEmpty {
      editor.dispatchCommand(type: .canRedo, payload: false)
    }

    externalHistoryState.current = historyStateEntry

    do {
      try editor.setEditorState(historyStateEntry.editorState.clone(selection: historyStateEntry.undoSelection))
      editor.dispatchCommand(type: .updatePlaceholderVisibility)
    } catch {
      editor.log(.other, .warning, "redo: Failed to setEditorState: \(error.localizedDescription)")
    }

    self.externalHistoryState = externalHistoryState
  }

  public func applyCommand(type: CommandType) {
    switch type {
    case .redo:
      redo()
    case .undo:
      undo()
    case .clearEditor:
      guard let externalHistoryState else { return }
      clearHistory(historyState: externalHistoryState)
    default:
      break
    }
  }

  func getMergeAction(
    prevEditorState: EditorState?,
    nextEditorState: EditorState,
    currentHistoryEntry: HistoryStateEntry?,
    dirtyNodes: DirtyNodeMap
  ) throws -> MergeAction {
    guard let editor else { return .discardHistoryCandidate }
    let changeTime = Date().timeIntervalSince1970

    if prevChangeTime == 0 {
      prevChangeTime = Date().timeIntervalSince1970
    }

    let changeType = try getChangeType(
      prevEditorState: prevEditorState,
      nextEditorState: nextEditorState,
      dirtyLeavesSet: dirtyNodes,
      isComposing: editor.isComposing())

    let selection = nextEditorState.selection
    let prevSelection = prevEditorState?.selection
    let hasDirtyNodes = !dirtyNodes.isEmpty
    if !hasDirtyNodes {
      if prevSelection == nil && selection != nil {
        prevChangeTime = changeTime
        prevChangeType = changeType

        return .historyMerge
      }

      // since we're discarding the candidate, do not cache the prev change time/type
      return .discardHistoryCandidate
    }

    let isSameEditor = currentHistoryEntry == nil || currentHistoryEntry?.editor == self.editor

    if changeType != .other && changeType == prevChangeType && changeTime < prevChangeTime + Double(delay) && isSameEditor {
      prevChangeTime = changeTime
      prevChangeType = changeType

      return .historyMerge
    }

    prevChangeTime = changeTime
    prevChangeType = changeType

    return .historyPush
  }
}

public struct HistoryStateEntry {
  weak var editor: Editor?
  var editorState: EditorState
  var undoSelection: RangeSelection?

  public init(editor: Editor?, editorState: EditorState, undoSelection: RangeSelection?) {
    self.editor = editor
    self.editorState = editorState
    self.undoSelection = undoSelection
  }
}

public final class HistoryState {
  var current: HistoryStateEntry?
  var redoStack: [HistoryStateEntry] = []
  var undoStack: [HistoryStateEntry] = []

  public init(current: HistoryStateEntry?, redoStack: [HistoryStateEntry], undoStack: [HistoryStateEntry]) {
    self.current = current
    self.redoStack = redoStack
    self.undoStack = undoStack
  }

  public func undoStackCount() -> Int {
    return undoStack.count
  }

  public func redoStackCount() -> Int {
    return redoStack.count
  }
}

func getDirtyNodes(
  editorState: EditorState,
  dirtyLeavesSet: DirtyNodeMap
) -> [Node] {
  let dirtyLeaves = dirtyLeavesSet
  let nodeMap = editorState.getNodeMap()
  var nodes: [Node] = []

  for (dirtyLeafKey, cause) in dirtyLeaves {
    if cause == .editorInitiated {
      continue
    }

    if let dirtyLeaf = nodeMap[dirtyLeafKey] {
      if dirtyLeaf is TextNode {
        nodes.append(dirtyLeaf)
      }
    }

    if let dirtyElement = nodeMap[dirtyLeafKey] {
      if dirtyElement is ElementNode && !isRootNode(node: dirtyElement) {
        nodes.append(dirtyElement)
      }
    }
  }
  return nodes
}

func getChangeType(
  prevEditorState: EditorState?,
  nextEditorState: EditorState,
  dirtyLeavesSet: DirtyNodeMap,
  isComposing: Bool
) throws -> ChangeType {
  guard let prevEditorState, !dirtyLeavesSet.isEmpty else { return .other }

  if isComposing {
    return .composingCharacter
  }

  guard let nextSelection = nextEditorState.selection,
    let prevSelection = prevEditorState.selection
  else {
    throw LexicalError.internal("Failed to find selection")
  }

  guard let nextSelection = nextSelection as? RangeSelection,
    let prevSelection = prevSelection as? RangeSelection
  else {
    return .other
  }

  if !prevSelection.isCollapsed() || !nextSelection.isCollapsed() {
    return .other
  }

  let dirtyNodes = getDirtyNodes(editorState: nextEditorState, dirtyLeavesSet: dirtyLeavesSet)
  if dirtyNodes.isEmpty {
    return .other
  }

  // Catching the case when inserting new text node into an element (e.g. first char in paragraph/list),
  // or after existing node.
  if dirtyNodes.count > 1 {
    let nextNodeMap = nextEditorState.getNodeMap()

    let prevAnchorNode = nextNodeMap[prevSelection.anchor.key]

    if let nextAnchorNode = nextNodeMap[nextSelection.anchor.key] as? TextNode,
      prevAnchorNode != nil,
      !prevEditorState.getNodeMap().keys.contains(nextAnchorNode.key),
      nextAnchorNode.getTextPartSize() == 1,
      nextSelection.anchor.offset == 1
    {
      return .insertCharacterAfterSelection
    }
    return .other
  }

  let nextDirtyNode = dirtyNodes[0]
  let prevDirtyNode = prevEditorState.getNodeMap()[nextDirtyNode.key]

  if !isTextNode(prevDirtyNode) || !isTextNode(nextDirtyNode) {
    return .other
  }

  guard
    let prevDirtyNode = prevDirtyNode as? TextNode,
    let nextDirtyNode = nextDirtyNode as? TextNode
  else {
    throw LexicalError.internal("prev/nextDirtyNode is not TextNode")
  }

  if prevDirtyNode.getMode_dangerousPropertyAccess() != nextDirtyNode.getMode_dangerousPropertyAccess() {
    return .other
  }

  // we don't want the text from latest node
  let prevText = prevDirtyNode.getText_dangerousPropertyAccess()
  let nextText = nextDirtyNode.getText_dangerousPropertyAccess()
  if prevText == nextText {
    return .other
  }

  let nextAnchor = nextSelection.anchor
  let prevAnchor = prevSelection.anchor
  if nextAnchor.key != prevAnchor.key || nextAnchor.type != .text {
    return .other
  }

  let nextAnchorOffset = nextAnchor.offset
  let prevAnchorOffset = prevAnchor.offset
  let textDiff = nextText.lengthAsNSString() - prevText.lengthAsNSString()
  if textDiff == 1 && prevAnchorOffset == nextAnchorOffset - 1 {
    return .insertCharacterAfterSelection
  }
  if textDiff == -1 && prevAnchorOffset == nextAnchorOffset + 1 {
    return .deleteCharacterBeforeSelection
  }
  if textDiff == -1 && prevAnchorOffset == nextAnchorOffset {
    return .deleteCharacterAfterSelection
  }
  return .other
}

public func createEmptyHistoryState() -> HistoryState {
  HistoryState(current: nil, redoStack: [], undoStack: [])
}

func clearHistory(historyState: HistoryState) {
  historyState.undoStack.removeAll()
  historyState.redoStack.removeAll()
  historyState.current = nil
}
