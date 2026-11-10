/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import Lexical
import UIKit

open class EditorHistoryPlugin: Plugin {
  public init() {}

  weak var editor: Editor?

  var editorHistory: EditorHistory?
  var historyState: HistoryState?

  public func setUp(editor: Editor) {
    self.editor = editor

    let historyState = createEmptyHistoryState()
    self.historyState = historyState

    editorHistory = EditorHistory(editor: editor, externalHistoryState: historyState)

    setUpListeners()
  }

  public func tearDown() {
    if let removeUndoListener {
      removeUndoListener()
    }
    if let removeRedoListener {
      removeRedoListener()
    }
    if let removeClearEditorListener {
      removeClearEditorListener()
    }
    if let removeUpdateListener {
      removeUpdateListener()
    }
  }

  public private(set) lazy var undoManager: UndoManager = HistoryUndoManager(plugin: self)

  public var canUndo: Bool {
    get {
      guard let historyState else {
        return false
      }
      return historyState.undoStackCount() > 0
    }
  }

  public var canRedo: Bool {
    get {
      guard let historyState else {
        return false
      }
      return historyState.redoStackCount() > 0
    }
  }

  private var removeUndoListener: Editor.RemovalHandler?
  private var removeRedoListener: Editor.RemovalHandler?
  private var removeClearEditorListener: Editor.RemovalHandler?
  private var removeUpdateListener: Editor.RemovalHandler?

  private func setUpListeners() {
    guard let editor else {
      return
    }

    removeUndoListener = editor.registerCommand(
      type: .undo,
      listener: { [weak self] payload in
        guard let self, let editorHistory else { return false }
        editorHistory.applyCommand(type: .undo)
        return true
      })

    removeRedoListener = editor.registerCommand(
      type: .redo,
      listener: { [weak self] payload in
        guard let self, let editorHistory else { return false }
        editorHistory.applyCommand(type: .redo)
        return true
      })

    removeClearEditorListener = editor.registerCommand(
      type: .clearEditor,
      listener: { [weak self] payload in
        guard let self, let editorHistory else { return false }
        editorHistory.applyCommand(type: .clearEditor)
        return false
      })

    removeUpdateListener = editor.registerUpdateListener(listener: { [weak self] (activeEditorState, previousEditorState, dirtyNodes) in
      guard let self, let editorHistory else { return }

      editorHistory.applyChange(
        editorState: activeEditorState,
        prevEditorState: previousEditorState,
        dirtyNodes: dirtyNodes)
    })
  }
}

// UIKit drives shake, ⌘Z and the keyboard's undo buttons through the first responder's UndoManager;
// Lexical owns the edits, so undo must replay editor history rather than UIKit's registered actions.
final class HistoryUndoManager: UndoManager {
  private weak var plugin: EditorHistoryPlugin?

  init(plugin: EditorHistoryPlugin) {
    self.plugin = plugin
    super.init()
  }

  override var canUndo: Bool { plugin?.canUndo ?? false }
  override var canRedo: Bool { plugin?.canRedo ?? false }

  override func undo() {
    guard canUndo else { return }
    plugin?.editor?.dispatchCommand(type: .undo)
    NotificationCenter.default.post(name: .NSUndoManagerDidUndoChange, object: self)
  }

  override func redo() {
    guard canRedo else { return }
    plugin?.editor?.dispatchCommand(type: .redo)
    NotificationCenter.default.post(name: .NSUndoManagerDidRedoChange, object: self)
  }
}
