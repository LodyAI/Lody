/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class RangeCacheTests: XCTestCase {

  func testSearchRangeCacheForPoints() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    let rangeCache = editor.rangeCache

    try editor.update {
      guard let point1 = try pointAtStringLocation(0, searchDirection: .forward, rangeCache: rangeCache),
        let point2 = try pointAtStringLocation(1, searchDirection: .forward, rangeCache: rangeCache),
        let point3 = try pointAtStringLocation(6, searchDirection: .forward, rangeCache: rangeCache),
        let point4 = try pointAtStringLocation(6, searchDirection: .backward, rangeCache: rangeCache),
        let point5 = try pointAtStringLocation(11, searchDirection: .forward, rangeCache: rangeCache),
        let point6 = try pointAtStringLocation(12, searchDirection: .forward, rangeCache: rangeCache),
        let point7 = try pointAtStringLocation(51, searchDirection: .forward, rangeCache: rangeCache)
      else {
        XCTFail("Expected points")
        return
      }

      XCTAssertEqual(point1.key, "1")
      XCTAssertEqual(point1.type, .text)
      XCTAssertEqual(point1.offset, 0)

      XCTAssertEqual(point2.key, "1")
      XCTAssertEqual(point2.type, .text)
      XCTAssertEqual(point2.offset, 1)

      XCTAssertEqual(point3.key, "1")
      XCTAssertEqual(point3.type, .text)
      XCTAssertEqual(point3.offset, 6)

      XCTAssertEqual(point4.key, "2")
      XCTAssertEqual(point4.type, .text)
      XCTAssertEqual(point4.offset, 0)

      XCTAssertEqual(point5.key, "2")
      XCTAssertEqual(point5.type, .text)
      XCTAssertEqual(point5.offset, 5)

      XCTAssertEqual(point6.key, "3")
      XCTAssertEqual(point6.type, .text)
      XCTAssertEqual(point6.offset, 0)

      XCTAssertEqual(point7.key, "5")
      XCTAssertEqual(point7.type, .element)
      XCTAssertEqual(point7.offset, 0)
    }
  }

  func testSearchRangeCacheForLastParagraphWithNoChildren() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let rootNode = getActiveEditorState()?.nodeMap[kRootNodeKey] as? ElementNode,
        let firstParagraph = getNodeByKey(key: "0") as? ParagraphNode
      else {
        XCTFail("Failed to get the rootNode")
        return
      }

      let textNode1 = TextNode()
      try textNode1.setText("This is first paragraph")
      try firstParagraph.append([textNode1])

      let newParagraphNode = ParagraphNode()
      let anotherParagraph = ParagraphNode()

      let textNode2 = TextNode()
      try textNode2.setText("This is third paragraph")

      try anotherParagraph.append([textNode2])

      let yetAnotherParagraph = ParagraphNode()
      try rootNode.append([newParagraphNode, anotherParagraph, yetAnotherParagraph])

      // location points to yetAnotherParagraph
      guard let newPoint = try pointAtStringLocation(49, searchDirection: .forward, rangeCache: editor.rangeCache) else { return }

      XCTAssertEqual(newPoint.key, yetAnotherParagraph.key)
      XCTAssertEqual(newPoint.type, .element)
      XCTAssertEqual(newPoint.offset, 0)

      let selection = RangeSelection(anchor: newPoint, focus: newPoint, format: TextFormat())
      try selection.insertText("Test")

      if let newTextNode = yetAnotherParagraph.getFirstChild() as? TextNode {
        XCTAssertEqual(newTextNode.getTextPart(), "Test")
      } else {
        XCTFail("Failed to add new text node to yetAnotherParagraph")
      }
    }
  }
}
