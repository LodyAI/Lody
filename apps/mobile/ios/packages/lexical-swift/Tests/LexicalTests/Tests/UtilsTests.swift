/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class UtilsTests: XCTestCase {
  func testInitializeEditor() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editorState = view.editor.getEditorState()

    guard let rootNode = editorState.nodeMap[kRootNodeKey] as? RootNode else {
      XCTFail("Failed to create editor state and rootNode")
      return
    }

    guard let selection = editorState.selection as? RangeSelection else {
      XCTFail("Expected range selection")
      return
    }

    XCTAssertEqual(rootNode.children.count, 1, "Expected 1 child")
    XCTAssertEqual(rootNode.children[0], "0")

    guard let paragraphNode = getNodeByKey(key: "0") else { return }

    XCTAssertEqual(paragraphNode.parent, kRootNodeKey)
    XCTAssertNotNil(selection)
    XCTAssertEqual(selection.anchor.key, "0")
    XCTAssertEqual(selection.focus.key, "0")
    XCTAssertEqual(selection.anchor.type, SelectionType.element)
    XCTAssertEqual(selection.focus.type, SelectionType.element)
    XCTAssertEqual(selection.anchor.offset, 0)
    XCTAssertEqual(selection.focus.offset, 0)
  }

  func testDefaultClearEditor() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())

    try view.editor.update {
      createExampleNodeTree()

      guard let root = getNodeByKey(key: kRootNodeKey) as? RootNode else { return }

      XCTAssertEqual(root.getChildren().count, 4, "Root should have 4 children")
    }

    try view.textView.defaultClearEditor()

    try view.editor.read {
      guard let root = getNodeByKey(key: kRootNodeKey) as? RootNode else { return }

      XCTAssertEqual(root.getChildren().count, 1, "Root should have one child")
    }
  }

  func testSelectionAfterInsertText() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    try onInsertTextFromUITextView(text: "Hello", editor: view.editor)
    guard let selection = view.editor.getEditorState().selection as? RangeSelection else {
      XCTFail("Expected range selection")
      return
    }
    XCTAssertEqual(selection.anchor.offset, 5, "Selection offset should be 5")
  }

  func testGetSelectionAfterInsertText() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    try onInsertTextFromUITextView(text: "Hello", editor: view.editor)
    try view.editor.read {
      guard let selection = try getSelection() as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }
      XCTAssertEqual(selection.anchor.offset, 5, "Selection offset should be 5")
    }
  }

  func testGetSelectionData() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())

    try onInsertTextFromUITextView(text: "Hello", editor: view.editor)
    let selection = try getSelectionData(editorState: view.editor.getEditorState())
    XCTAssertNotNil(selection)
    // selection should be at offset = 5 after "Hello gets inserted"
    let offset = selection.contains("5")
    XCTAssertTrue(offset, "Selection does not contain '5'. \(String(describing: selection))")
  }

  func testDefaultClearEditorWithBoldSelectionFormat() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())

    try view.editor.update {
      guard let selection = try getSelection() as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }
      try selection.formatText(formatType: .bold)
    }

    try onInsertTextFromUITextView(text: "Hello", editor: view.editor)
    var selection: RangeSelection?
    try? view.editor.read {
      guard let newSelection = try getSelection() as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }
      selection = newSelection
    }
    XCTAssertEqual(selection?.format.bold, true)

    try view.textView.defaultClearEditor()

    try? view.editor.read {
      guard let newSelection = try getSelection() as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }
      selection = newSelection
    }
    print("updatedSelection: \(selection.debugDescription)")
    XCTAssertEqual(selection?.format.bold, false)
  }
}
