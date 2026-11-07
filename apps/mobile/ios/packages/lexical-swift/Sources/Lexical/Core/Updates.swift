/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

/* These functions will return a value when inside a read or update block. They should not be used when
 * not inside a read or update block (and will return nil in that case).
 */

public func getActiveEditor() -> Editor? {
  return Thread.current.threadDictionary[activeEditorThreadDictionaryKey] as? Editor
}

public func getActiveEditorState() -> EditorState? {
  return Thread.current.threadDictionary[activeEditorStateThreadDictionaryKey] as? EditorState
}

public func isReadOnlyMode() -> Bool {
  if let readOnlyMode = Thread.current.threadDictionary[readOnlyModeThreadDictionaryKey] as? Bool {
    return readOnlyMode
  }
  return true
}

internal func isEditorPresentInUpdateStack(_ editor: Editor) -> Bool {
  let updateEditors: [Editor] = Thread.current.threadDictionary[previousParentUpdateBlocksThreadDictionaryKey] as? [Editor] ?? []
  return updateEditors.contains(editor)
}

public func errorOnReadOnly() throws {
  if isReadOnlyMode() {
    throw LexicalError.invariantViolation("Editor should be in writeable state")
  }
}

public func triggerUpdateListeners(activeEditor: Editor, activeEditorState: EditorState, previousEditorState: EditorState, dirtyNodes: DirtyNodeMap) {
  for listener in activeEditor.listeners.update.values {
    listener(activeEditorState, previousEditorState, dirtyNodes)
  }
}

func triggerErrorListeners(activeEditor: Editor, activeEditorState: EditorState, previousEditorState: EditorState, error: Error) {
  for listener in activeEditor.listeners.errors.values {
    listener(activeEditorState, previousEditorState, error)
  }
}

public func triggerTextContentListeners(activeEditor: Editor, activeEditorState: EditorState, previousEditorState: EditorState) throws {
  let activeTextContent = try getEditorStateTextContent(editorState: activeEditorState)
  let previousTextContent = try getEditorStateTextContent(editorState: previousEditorState)

  if activeTextContent != previousTextContent {
    for listener in activeEditor.listeners.textContent.values {
      listener(activeTextContent)
    }
  }
}

public func triggerCommandListeners(activeEditor: Editor, type: CommandType, payload: Any?) -> Bool {
  let listenersInPriorityOrder = activeEditor.commands[type]

  var handled = false

  let closure: () throws -> Void = {
    for priority in [
      CommandPriority.Critical,
      CommandPriority.High,
      CommandPriority.Normal,
      CommandPriority.Low,
      CommandPriority.Editor,
    ] {
      guard let listeners = listenersInPriorityOrder?[priority]?.values else {
        continue
      }

      // TODO: handle throws
      for wrapper in listeners {
        let listener = wrapper.listener
        if listener(payload) {
          handled = true
          return
        }
      }
    }
  }

  var shouldWrapInUpdateBlock = false
  for p in (listenersInPriorityOrder ?? [:]).values {
    for metadata in p.values {
      if metadata.shouldWrapInUpdateBlock {
        shouldWrapInUpdateBlock = true
      }
    }
  }

  do {
    if shouldWrapInUpdateBlock && !activeEditor.isUpdating {
      try activeEditor.update(closure)
    } else {
      try closure()
    }
  } catch {
    print("\(error)")
    return false
  }

  if handled { return true }

  if let parent = activeEditor.parentEditor {
    return triggerCommandListeners(activeEditor: parent, type: type, payload: payload)
  }

  // no parent, no handler
  return false
}

// MARK: - Private implementation

private let activeEditorThreadDictionaryKey = "kActiveEditor"
private let activeEditorStateThreadDictionaryKey = "kActiveEditorState"
private let readOnlyModeThreadDictionaryKey = "kReadOnlyMode"
private let previousParentUpdateBlocksThreadDictionaryKey = "kpreviousParentUpdateBlocks"

internal func runWithStateLexicalScopeProperties(activeEditor: Editor?, activeEditorState: EditorState?, readOnlyMode: Bool, closure: () throws -> Void) throws {
  let previousActiveEditor = Thread.current.threadDictionary[activeEditorThreadDictionaryKey]
  let previousActiveEditorState = Thread.current.threadDictionary[activeEditorStateThreadDictionaryKey]
  let previousReadOnly = Thread.current.threadDictionary[readOnlyModeThreadDictionaryKey]
  let previousParentUpdateBlocks: [Editor] = Thread.current.threadDictionary[previousParentUpdateBlocksThreadDictionaryKey] as? [Editor] ?? []

  Thread.current.threadDictionary[activeEditorThreadDictionaryKey] = activeEditor
  Thread.current.threadDictionary[activeEditorStateThreadDictionaryKey] = activeEditorState
  Thread.current.threadDictionary[readOnlyModeThreadDictionaryKey] = readOnlyMode

  defer {
    Thread.current.threadDictionary[activeEditorThreadDictionaryKey] = previousActiveEditor
    Thread.current.threadDictionary[activeEditorStateThreadDictionaryKey] = previousActiveEditorState
    Thread.current.threadDictionary[readOnlyModeThreadDictionaryKey] = previousReadOnly
    Thread.current.threadDictionary[previousParentUpdateBlocksThreadDictionaryKey] = previousParentUpdateBlocks
  }

  if let activeEditor, readOnlyMode == false {
    var newParentUpdateBlocks = previousParentUpdateBlocks
    newParentUpdateBlocks.append(activeEditor)
    Thread.current.threadDictionary[previousParentUpdateBlocksThreadDictionaryKey] = newParentUpdateBlocks
  }

  try closure()
}
