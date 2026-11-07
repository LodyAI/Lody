/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import EditorHistoryPlugin
@testable import Lexical
import XCTest

final class HistoryTests: XCTestCase {

  var view: LexicalView?
  var historyPlugin: EditorHistoryPlugin?
  var editor: Editor {
    get {
      guard let editor = view?.editor else {
        XCTFail("Editor unexpectedly nil")
        fatalError()
      }
      return editor
    }
  }

  var editorHistory: EditorHistory {
    get {
      guard let historyPlugin, let editorHistory = historyPlugin.editorHistory else {
        XCTFail("historyPlugin unexpectedly nil")
        fatalError()
      }
      return editorHistory
    }
  }

  override func setUp() {
    let historyPlugin = EditorHistoryPlugin()
    self.historyPlugin = historyPlugin

    view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: [historyPlugin]), featureFlags: FeatureFlags())
  }

  override func tearDown() {
    view = nil
  }

  func testGetDirtyNodes() throws {
    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        XCTFail("should have editor state")
        return
      }
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode.append([paragraphNode])

      XCTAssertEqual(editor.dirtyNodes.count, 5)
      XCTAssert(editor.dirtyNodes[textNode.key] != nil)
    }
  }

  func testGetChangeType() throws {
    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        XCTFail("should have editor state")
        return
      }
      guard let pendingEditorState = editor.testing_getPendingEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let changeType = try getChangeType(prevEditorState: editorState, nextEditorState: pendingEditorState, dirtyLeavesSet: editor.dirtyNodes, isComposing: false)

      XCTAssertNotNil(editorState)
      XCTAssertEqual(changeType, .other)

      let textNode = TextNode()
      try textNode.setText("é")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try rootNode.append([paragraphNode])

      let changeType1 = try getChangeType(prevEditorState: editorState, nextEditorState: pendingEditorState, dirtyLeavesSet: editor.dirtyNodes, isComposing: true)
      XCTAssertEqual(changeType1, .composingCharacter)
    }
  }

  func testApplyHistory() throws {
    guard let view else {
      XCTFail()
      return
    }

    XCTAssertEqual(view.textStorage.string, "", "Text storage should be empty")
    view.textView.insertText("A")
    XCTAssertEqual(view.textStorage.string, "A", "Text storage should contain A")
    view.editor.dispatchCommand(type: .undo)
    XCTAssertEqual(view.textStorage.string, "", "Text storage should be empty")
  }

  func testUndoManagerUndoesAndRedoesTyping() throws {
    guard let view, let historyPlugin else { return XCTFail() }
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
    view.frame = window.bounds
    window.addSubview(view)
    window.isHidden = false
    view.textView.becomeFirstResponder()
    try editor.update { _ = try getRoot()?.selectEnd() }
    let undoManager = historyPlugin.undoManager
    XCTAssertFalse(undoManager.canUndo)
    view.textView.insertText("hello")
    XCTAssertTrue(undoManager.canUndo)
    undoManager.undo()
    XCTAssertEqual(view.textView.text, "")
    XCTAssertTrue(undoManager.canRedo)
    undoManager.redo()
    XCTAssertEqual(view.textView.text, "hello")
  }
}
