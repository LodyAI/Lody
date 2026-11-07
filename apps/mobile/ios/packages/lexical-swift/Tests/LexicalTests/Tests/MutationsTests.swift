/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class MutationsTests: XCTestCase {

  func testMutationIsControlledWhenDeletingAcrossNodes() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    XCTAssertEqual(view.textView.text, "hello world\nParagraph 2 contains another text node\n\nThird para.")

    view.textView.selectedRange = NSRange(location: 0, length: view.textView.textStorage.length)
    view.textView.insertText("1")

    try editor.getEditorState().read {
      guard let node = getNodeByKey(key: "1") else {
        XCTFail("Can't find node")
        return
      }

      XCTAssertEqual(node.getTextPart(), "1")
      XCTAssertNil(node.getParent()?.getPreviousSibling())
      XCTAssertNil(node.getParent()?.getNextSibling())
    }
  }
}
