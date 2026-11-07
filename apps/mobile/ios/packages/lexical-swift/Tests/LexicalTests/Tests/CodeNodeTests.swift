/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class CodeNodeTests: XCTestCase {
  var view: LexicalView?
  var editor: Editor? {
    get {
      return view?.editor
    }
  }

  override func setUp() {
    view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
  }

  override func tearDown() {
    view = nil
  }

  func testInsertNewAfter() throws {
    guard let editor else {
      XCTFail("Editor unexpectedly nil")
      return
    }

    try editor.update {
      guard
        let editorState = getActiveEditorState(),
        let rootNode = editorState.getRootNode()
      else {
        XCTFail("should have editor state")
        return
      }

      let codeNode = CodeNode()
      let firstCode = CodeHighlightNode()
      try firstCode.setText("Test1")

      let firstLinebreak = LineBreakNode()
      let secondLinebreak = LineBreakNode()

      try codeNode.append([firstCode, firstLinebreak, secondLinebreak])

      try rootNode.append([codeNode])

      editorState.selection = RangeSelection(
        anchor: Point(key: codeNode.key, offset: 3, type: .element),
        focus: Point(key: codeNode.key, offset: 3, type: .element),
        format: TextFormat())
    }

    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      guard let codeNode = getNodeByKey(key: "1") as? CodeNode else {
        XCTFail("Code node not found")
        return
      }

      guard let selection = editorState.selection as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }

      let newNode = try codeNode.insertNewAfter(selection: selection)
      XCTAssertNotNil(newNode)
      XCTAssertEqual(newNode?.parent, codeNode.parent)
      XCTAssertEqual(newNode?.type, NodeType.paragraph)
      XCTAssertNotEqual(newNode?.key, codeNode.key)
      XCTAssertEqual(newNode, codeNode.getNextSibling())
    }
  }
}
