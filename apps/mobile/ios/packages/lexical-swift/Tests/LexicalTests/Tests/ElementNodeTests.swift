/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class ElementNodeTests: XCTestCase {
  var view: LexicalView?
  var editor: Editor {
    get {
      guard let editor = view?.editor else {
        XCTFail("Editor unexpectedly nil")
        fatalError()
      }
      return editor
    }
  }

  override func setUp() {
    view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
  }

  override func tearDown() {
    view = nil
  }

  func testIsElementNode() throws {
    try editor.update {
      let node = ElementNode()
      let textNode = TextNode()
      try textNode.setText("hello")

      XCTAssert(isElementNode(node: node))
      XCTAssert(!isElementNode(node: textNode))
    }
  }

  func testElementNodeProperties() throws {
    try editor.update {
      let node = ElementNode()
      let extraNode = ElementNode()

      XCTAssertTrue(node.canExtractContents())
      XCTAssertTrue(node.canReplaceWith(replacement: extraNode))
      XCTAssertTrue(node.canInsertAfter(node: extraNode))
      XCTAssertTrue(node.canBeEmpty())
      XCTAssertTrue(node.canInsertTextBefore())
      XCTAssertTrue(node.canInsertTextAfter())
      XCTAssertTrue(node.canSelectionRemove())

      XCTAssertFalse(node.canInsertTab())
      XCTAssertFalse(node.excludeFromCopy())
      XCTAssertFalse(node.isInline())
      XCTAssertFalse(node.canMergeWith(node: extraNode))
    }
  }

  func testSelectWithNilSelection() throws {
    try editor.update {
      createExampleNodeTree()

      if let elementNode = getNodeByKey(key: "0") as? ElementNode {
        let selection = try elementNode.select(anchorOffset: nil, focusOffset: nil)
        XCTAssertEqual(selection.anchor.key, "0")
        XCTAssertEqual(selection.focus.key, "0")
        XCTAssertEqual(selection.anchor.offset, 2)
        XCTAssertEqual(selection.focus.offset, 2)
        XCTAssertEqual(selection.anchor.type, SelectionType.element)
        XCTAssertEqual(selection.focus.type, SelectionType.element)
        XCTAssertTrue(selection.dirty)
      }
    }
  }

  func testSelectWithSelection() throws {
    try editor.update {
      createExampleNodeTree()

      view?.textView.selectedRange = NSRange(location: 2, length: 4)
      if let elementNode = getNodeByKey(key: "4") as? ElementNode {
        let selection = try elementNode.select(anchorOffset: 20, focusOffset: 10)
        XCTAssertEqual(selection.anchor.key, "4")
        XCTAssertEqual(selection.focus.key, "4")
        XCTAssertEqual(selection.anchor.offset, 20)
        XCTAssertEqual(selection.focus.offset, 10)
        XCTAssertEqual(selection.anchor.type, SelectionType.element)
        XCTAssertEqual(selection.focus.type, SelectionType.element)
        XCTAssertTrue(selection.dirty)
      }
    }
  }

  func testSelectStart() throws {
    try editor.update {

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      guard let rootNode = getActiveEditorState()?.getRootNode() else {
        XCTFail("No root node")
        return
      }
      try rootNode.append([paragraphNode])

      let selection = try paragraphNode.selectStart()
      XCTAssert(selection.anchor.offset == 0)
    }
  }
}
