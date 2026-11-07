/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
@testable import LexicalListPlugin
import XCTest

final class ListItemNodeTests: XCTestCase {
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

  func testItemCharacterWithNestedNumberedList() throws {
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

      /*
       1. Item 1
       1. Nested item 1
       2. Nested item 2
       2. Item 2
       */

      // Root level
      let list = ListNode(listType: .number, start: 1)

      let item1 = ListItemNode()
      try item1.append([TextNode(text: "Item 1")])

      let item2 = ListItemNode()
      try item2.append([TextNode(text: "Item 2")])

      // Nested level
      let nestedList = ListNode(listType: .number, start: 1)

      let nestedListItem = ListItemNode()
      try nestedListItem.append([nestedList])

      let nestedItem1 = ListItemNode()
      try nestedItem1.append([TextNode(text: "Nested item 1")])

      let nestedItem2 = ListItemNode()
      try nestedItem2.append([TextNode(text: "Nested item 2")])

      try nestedList.append([nestedItem1, nestedItem2])

      // Putting it together
      try list.append([item1, nestedListItem, item2])
      try rootNode.append([list])

      // Assertions
      let theme = editor.getTheme()

      let item1Attrs = item1.getAttributedStringAttributes(theme: theme)[.listItem] as? ListItemAttribute
      XCTAssertEqual(item1Attrs?.listItemCharacter, "1.")

      let item2Attrs = item2.getAttributedStringAttributes(theme: theme)[.listItem] as? ListItemAttribute
      XCTAssertEqual(item2Attrs?.listItemCharacter, "2.")

      let nestedItem1Attrs = nestedItem1.getAttributedStringAttributes(theme: theme)[.listItem] as? ListItemAttribute
      XCTAssertEqual(nestedItem1Attrs?.listItemCharacter, "1.")

      let nestedItem2Attrs = nestedItem2.getAttributedStringAttributes(theme: theme)[.listItem] as? ListItemAttribute
      XCTAssertEqual(nestedItem2Attrs?.listItemCharacter, "2.")
    }
  }
}
