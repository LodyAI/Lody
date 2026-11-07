/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class SelectionHelpersTests: XCTestCase {
  func testRangeWithMultipleParagraphs() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let root = editor.getEditorState().getRootNode() else {
        XCTFail("Could not get root node")
        return
      }

      let text1 = TextNode()
      let text2 = TextNode()
      let text3 = TextNode()

      let paragraph1 = ParagraphNode()
      let paragraph2 = ParagraphNode()
      let paragraph3 = ParagraphNode()
      let paragraph4 = ParagraphNode()

      try text1.setText("First")
      try text2.setText("Second")
      try text3.setText("Third")

      try paragraph1.append([text1])
      try paragraph2.append([text2])
      try paragraph3.append([text3])

      try root.append([paragraph1, paragraph2, paragraph3, paragraph4])

      let selection1 = try text1.select(anchorOffset: 0, focusOffset: 0)
      selection1.focus.updatePoint(key: text3.key, offset: 1, type: .text)

      let selectedNodes1 = try cloneContents(selection: selection1)

      XCTAssertEqual(selectedNodes1.range, [paragraph1.key, paragraph2.key, paragraph3.key], "range not equal to 3 para keys")
      XCTAssertEqual((selectedNodes1.nodeMap[paragraph1.key] as? ParagraphNode)?.getChildrenSize(), 1, "para 1 not got 1 child")
      XCTAssertTrue((selectedNodes1.nodeMap[paragraph1.key] as? ParagraphNode)?.children.contains(text1.key) ?? false, "para 1 not got text node child")
      XCTAssertEqual((selectedNodes1.nodeMap[paragraph2.key] as? ParagraphNode)?.getChildrenSize(), 1, "para 2 not got 1 child")
      XCTAssertTrue((selectedNodes1.nodeMap[paragraph2.key] as? ParagraphNode)?.children.contains(text2.key) ?? false, "para 2 not got text node child")
      XCTAssertEqual((selectedNodes1.nodeMap[paragraph3.key] as? ParagraphNode)?.getChildrenSize(), 1, "para 3 not got 1 child")
      XCTAssertTrue((selectedNodes1.nodeMap[paragraph3.key] as? ParagraphNode)?.children.contains(text3.key) ?? false, "para 3 not got text node child")
      XCTAssertTrue((selectedNodes1.nodeMap[text1.key] as? TextNode)?.getText_dangerousPropertyAccess() == "First", "text 1 not 'First'")
      XCTAssertTrue((selectedNodes1.nodeMap[text3.key] as? TextNode)?.getText_dangerousPropertyAccess() == "T", "text 3 not 'T'")

      let selection2 = try text1.select(anchorOffset: 1, focusOffset: 1)
      selection2.focus.updatePoint(key: text3.key, offset: 4, type: .text)

      let selectedNodes2 = try cloneContents(selection: selection2)
      XCTAssertEqual(selectedNodes2.range, [paragraph1.key, paragraph2.key, paragraph3.key])
      XCTAssertEqual((selectedNodes2.nodeMap[paragraph1.key] as? ParagraphNode)?.getChildrenSize(), 1)
      XCTAssertTrue((selectedNodes2.nodeMap[paragraph1.key] as? ParagraphNode)?.children.contains(text1.key) ?? false)
      XCTAssertEqual((selectedNodes2.nodeMap[paragraph2.key] as? ParagraphNode)?.getChildrenSize(), 1)
      XCTAssertTrue((selectedNodes2.nodeMap[paragraph2.key] as? ParagraphNode)?.children.contains(text2.key) ?? false)
      XCTAssertEqual((selectedNodes2.nodeMap[paragraph3.key] as? ParagraphNode)?.getChildrenSize(), 1)
      XCTAssertTrue((selectedNodes2.nodeMap[paragraph3.key] as? ParagraphNode)?.children.contains(text3.key) ?? false)
      XCTAssertTrue((selectedNodes2.nodeMap[text1.key] as? TextNode)?.getText_dangerousPropertyAccess() == "irst")
      XCTAssertTrue((selectedNodes2.nodeMap[text3.key] as? TextNode)?.getText_dangerousPropertyAccess() == "Thir")

      let selection3 = try text1.select(anchorOffset: 1, focusOffset: 1)
      selection3.focus.updatePoint(key: text1.key, offset: 4, type: .text)

      let selectedNodes3 = try cloneContents(selection: selection3)
      XCTAssertEqual(selectedNodes3.range, [text1.key])
      XCTAssertTrue((selectedNodes3.nodeMap[text1.key] as? TextNode)?.getText_dangerousPropertyAccess() == "irs")

      let selection4 = try text1.select(anchorOffset: 1, focusOffset: 1)
      selection3.focus.updatePoint(key: paragraph4.key, offset: 0, type: .element)

      let selectedNodes4 = try cloneContents(selection: selection4)
      XCTAssertEqual(selectedNodes4.range, [paragraph1.key, paragraph2.key, paragraph3.key, paragraph4.key])
      XCTAssertTrue((selectedNodes4.nodeMap[text1.key] as? TextNode)?.getText_dangerousPropertyAccess() == "irst")
      XCTAssertEqual((selectedNodes4.nodeMap[paragraph4.key] as? ParagraphNode)?.getChildrenSize(), 0)
    }
  }
}
