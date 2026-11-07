/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class ParagraphNodeTests: XCTestCase {
  func testinsertNewAfter() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let editorState = getActiveEditorState(),
        let rootNode = editorState.getRootNode()
      else {
        XCTFail("should have editor state")
        return
      }

      let paragraphNode = ParagraphNode()
      try rootNode.append([paragraphNode])
    }

    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      guard let paragraphNode = getNodeByKey(key: "0") as? ParagraphNode else {
        XCTFail("Paragraph node not found")
        return
      }

      guard let selection = editorState.selection as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }

      let newNode = try paragraphNode.insertNewAfter(selection: selection)
      XCTAssertNotNil(newNode)
      XCTAssertEqual(newNode?.parent, paragraphNode.parent)
      XCTAssertEqual(newNode?.type, paragraphNode.type)
      XCTAssertNotEqual(newNode?.key, paragraphNode.key)
      XCTAssertEqual(newNode, paragraphNode.getNextSibling())
    }
  }
}
