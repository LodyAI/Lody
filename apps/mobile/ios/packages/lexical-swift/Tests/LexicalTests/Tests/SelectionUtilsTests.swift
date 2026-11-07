/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class SelectionUtilsTests: XCTestCase {
  func testCreatePoint() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode2.key, offset: 4, type: .text)
      let anotherPoint = createPoint(key: paragraphNode.key, offset: 2, type: .element)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      let selection2 = RangeSelection(anchor: anotherPoint, focus: anotherPoint, format: TextFormat())

      XCTAssertEqual(startPoint.offset, 0)
      XCTAssertEqual(anotherPoint.type, .element)

      XCTAssertEqual(try startPoint.getNode().key, textNode.key)
      XCTAssertEqual(try endPoint.getNode().key, textNode2.key)

      XCTAssertTrue(try startPoint.getNode() === textNode, "startPoint's node should be same as textNode")
      XCTAssertTrue(try endPoint.getNode() === textNode2, "endPoint's node should be same as textNode2")
      XCTAssertFalse(selection == selection2, "both objects point to different selection")

      XCTAssertFalse(try startPoint.isAtNodeEnd(), "startPoint is at start at textNode")
      XCTAssertFalse(try endPoint.isAtNodeEnd(), "endPoint doesn't point to last node")
      XCTAssertTrue(try anotherPoint.isAtNodeEnd(), "anotherPoint includes both children of paragraphNode")
    }
  }

  func testSelectPointOnNode() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let textNode3 = TextNode()
      try textNode3.setText("again!")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])
      try paragraphNode.append([textNode3])

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode2.key, offset: 4, type: .text)

      selectPointOnNode(point: startPoint, node: textNode2)
      selectPointOnNode(point: endPoint, node: textNode3)

      XCTAssertEqual(startPoint.key, textNode2.key)
      XCTAssertEqual(endPoint.key, textNode3.key)
    }
  }

  func testCreateNativeSelectionInSameNode() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    try editor.getEditorState().read {
      let selection = RangeSelection(
        anchor: Point(key: "2", offset: 1, type: .text),
        focus: Point(key: "2", offset: 3, type: .text),
        format: TextFormat())

      let textSelection = try createNativeSelection(from: selection, editor: editor)
      XCTAssertNotNil(textSelection.range)
      XCTAssertEqual(textSelection.affinity, .forward)
      XCTAssertEqual(textSelection.range?.location, 7)
      XCTAssertEqual(textSelection.range?.length, 2)

      let selection2 = RangeSelection(
        anchor: Point(key: "2", offset: 6, type: .text),
        focus: Point(key: "2", offset: 2, type: .text),
        format: TextFormat())

      let textSelection2 = try createNativeSelection(from: selection2, editor: editor)
      XCTAssertNotNil(textSelection2.range)
      XCTAssertEqual(textSelection2.affinity, .backward)
      XCTAssertEqual(textSelection2.range?.location, 8)
      XCTAssertEqual(textSelection2.range?.length, 4)

      let selection3 = RangeSelection(
        anchor: Point(key: "6", offset: 6, type: .text),
        focus: Point(key: "6", offset: 6, type: .text),
        format: TextFormat())

      let textSelection3 = try createNativeSelection(from: selection3, editor: editor)
      XCTAssertNotNil(textSelection3.range)
      XCTAssertEqual(textSelection3.affinity, .forward)
      XCTAssertEqual(textSelection3.range?.location, 58)
      XCTAssertEqual(textSelection3.range?.length, 0)
    }
  }

  func testCreateNativeSelectionBetweenSiblings() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    try editor.getEditorState().read {
      let selection = RangeSelection(
        anchor: Point(key: "1", offset: 1, type: .text),
        focus: Point(key: "2", offset: 3, type: .text),
        format: TextFormat())

      let textSelection = try createNativeSelection(from: selection, editor: editor)
      XCTAssertNotNil(textSelection.range)
      XCTAssertEqual(textSelection.affinity, .forward)
      XCTAssertEqual(textSelection.range?.location, 1)
      XCTAssertEqual(textSelection.range?.length, 8)

      let selection2 = RangeSelection(
        anchor: Point(key: "2", offset: 4, type: .text),
        focus: Point(key: "1", offset: 3, type: .text),
        format: TextFormat())

      let textSelection2 = try createNativeSelection(from: selection2, editor: editor)
      XCTAssertNotNil(textSelection2.range)
      XCTAssertEqual(textSelection2.affinity, .backward)
      XCTAssertEqual(textSelection2.range?.location, 3)
      XCTAssertEqual(textSelection2.range?.length, 7)
    }
  }

  func testCreateNativeSelectionWithinElementNode() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let editorState = getActiveEditorState(),
        let rootNode = editorState.getRootNode()
      else {
        XCTFail("should have editor state")
        return
      }

      let textNode1 = TextNode() // key 1
      let textNode2 = TextNode() // key 2
      try textNode1.setText("Hello ")
      try textNode1.setBold(true)
      try textNode2.setText("Adios")

      guard let paragraphNode0 = rootNode.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }

      try paragraphNode0.append([textNode1, textNode2])

      let textNode3 = TextNode() // key 3
      let textNode4 = TextNode() // key 4
      let textNode5 = TextNode() // key 5
      try textNode3.setText("This is a new test.")
      try textNode3.setBold(true)
      try textNode4.setText("Checking selection between")
      try textNode5.setText("element types")
      try textNode5.setBold(true)

      let paragraphNode1 = ParagraphNode() // key 6

      try paragraphNode1.append([textNode3, textNode4, textNode5])

      try rootNode.append([paragraphNode1])
    }

    try editor.getEditorState().read {
      let selection = RangeSelection(
        anchor: Point(key: "0", offset: 1, type: .element),
        focus: Point(key: "0", offset: 1, type: .element),
        format: TextFormat())

      let textSelection = try createNativeSelection(from: selection, editor: editor)
      XCTAssertNotNil(textSelection.range)
      XCTAssertEqual(textSelection.affinity, .forward, "1 fail")
      XCTAssertEqual(textSelection.range?.location, 6, "Offset for native selection should be 6")
      XCTAssertEqual(textSelection.range?.length, 0, "length of current selection should be 0")

      let selection2 = RangeSelection(
        anchor: Point(key: "6", offset: 2, type: .element),
        focus: Point(key: "6", offset: 1, type: .element),
        format: TextFormat())

      let textSelection2 = try createNativeSelection(from: selection2, editor: editor)
      XCTAssertNotNil(textSelection2.range)
      XCTAssertEqual(textSelection2.affinity, .backward, "2 fail")
      XCTAssertEqual(textSelection2.range?.location, 31)
      XCTAssertEqual(textSelection2.range?.length, 26)

      let selection3 = RangeSelection(
        anchor: Point(key: "0", offset: 1, type: .element),
        focus: Point(key: "6", offset: 2, type: .element),
        format: TextFormat())

      let textSelection3 = try createNativeSelection(from: selection3, editor: editor)
      XCTAssertNotNil(textSelection3.range)
      XCTAssertEqual(textSelection3.affinity, .forward, "3 fail")
      XCTAssertEqual(textSelection3.range?.location, 6)
      XCTAssertEqual(textSelection3.range?.length, 51)
    }
  }

  func testExhaustiveLocationRoundtrip() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    for i in 0...view.textStorage.string.lengthAsNSString() {
      try editor.update {
        guard let point = try pointAtStringLocation(i, searchDirection: .forward, rangeCache: editor.rangeCache) else {
          XCTFail("Couldn't generate point for string location")
          return
        }
        guard let location = try stringLocationForPoint(point, editor: editor) else {
          XCTFail("Couldn't generate string location for point")
          return
        }
        XCTAssertEqual(i, location, "Location did not match after a roundtrip")
      }
    }
  }

  func testExhaustiveSelectionRoundtrip() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    for i in 0...view.textStorage.string.lengthAsNSString() {
      for j in i...view.textStorage.string.lengthAsNSString() {
        try editor.update {
          guard let point = try pointAtStringLocation(i, searchDirection: .forward, rangeCache: editor.rangeCache),
            let point2 = try pointAtStringLocation(j, searchDirection: .forward, rangeCache: editor.rangeCache)
          else {
            XCTFail("Couldn't generate points for string location")
            return
          }

          guard let location1 = try stringLocationForPoint(point, editor: editor),
            let location2 = try stringLocationForPoint(point2, editor: editor)
          else {
            XCTFail("Couldn't generate string location for point")
            return
          }

          XCTAssertEqual(i, location1, "Point for i does not match")
          XCTAssertEqual(j, location2, "Point for j does not match")

          if i != j {
            // in this algorithm, i will always be before or equal to j. If they're not equal, i should be before j.
            XCTAssertTrue(try point.isBefore(point: point2), "isBefore incorrect")
          }

          let selection = RangeSelection(anchor: point, focus: point2, format: TextFormat())
          let textViewSelection = try createNativeSelection(from: selection, editor: editor)
          guard let range = textViewSelection.range else {
            XCTFail("Couldn't generate text selection with range")
            return
          }
          XCTAssertEqual(i, range.location, "Location did not match after a roundtrip")
          XCTAssertEqual(j, range.location + range.length, "Length did not match after a roundtrip")
        }
      }
    }
  }

  func testCreateEmptyRangeSelection() {
    let selection = createEmptyRangeSelection()

    XCTAssertNotNil(selection)
    XCTAssertEqual(selection.anchor.key, kRootNodeKey)
    XCTAssertEqual(selection.anchor.offset, 0)
    XCTAssertEqual(selection.anchor.type, SelectionType.element)
    XCTAssertEqual(selection.focus.key, kRootNodeKey)
    XCTAssertEqual(selection.focus.offset, 0)
    XCTAssertEqual(selection.focus.type, SelectionType.element)
  }

  func testCreateRangeSelection() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    view.textView.selectedRange = NSRange(location: 0, length: 5)

    try editor.update {
      guard let selection = editor.testing_getPendingEditorState()?.selection as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }
      XCTAssertEqual(selection.anchor.key, "1")
      XCTAssertEqual(selection.anchor.offset, 0)
      XCTAssertEqual(selection.focus.key, "1")
      XCTAssertEqual(selection.focus.offset, 5)
    }
  }

  func testadjustPointOffsetForMergedSibling() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode2.key, offset: 4, type: .text)

      adjustPointOffsetForMergedSibling(
        point: startPoint,
        isBefore: true,
        key: textNode.key,
        target: textNode,
        textLength: 6)

      adjustPointOffsetForMergedSibling(
        point: endPoint,
        isBefore: false,
        key: textNode2.key,
        target: textNode2,
        textLength: 5)

      XCTAssertEqual(startPoint.key, textNode.key)
      XCTAssertEqual(startPoint.offset, 0)
      XCTAssertEqual(endPoint.offset, 9)
    }
  }

  func testmoveSelectionPointToSibling() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      let startPoint = createPoint(key: textNode.key, offset: 1, type: .text)

      moveSelectionPointToSibling(point: startPoint, node: textNode, parent: paragraphNode)
      XCTAssertTrue(startPoint.offset == 0)
    }
  }

  func testUpdateElementSelectionOnCreateDeleteNode() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let startPoint = createPoint(key: textNode.key, offset: 3, type: .text)
      let endPoint = createPoint(key: textNode.key, offset: 3, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      try updateElementSelectionOnCreateDeleteNode(selection: selection, parentNode: textNode, nodeOffset: 2, times: 1)
      XCTAssertEqual(selection.focus.offset, 4)

      let startPoint2 = createPoint(key: textNode.key, offset: 3, type: .text)
      let endPoint2 = createPoint(key: textNode2.key, offset: 5, type: .text)
      let selection2 = RangeSelection(anchor: startPoint2, focus: endPoint2, format: TextFormat())
      try updateElementSelectionOnCreateDeleteNode(selection: selection2, parentNode: textNode, nodeOffset: 2, times: 1)
      XCTAssertEqual(selection2.focus.offset, 5)

      let startPoint3 = createPoint(key: textNode.key, offset: 3, type: .text)
      let endPoint3 = createPoint(key: textNode2.key, offset: 5, type: .text)
      let selection3 = RangeSelection(anchor: startPoint3, focus: endPoint3, format: TextFormat())
      try updateElementSelectionOnCreateDeleteNode(selection: selection3, parentNode: textNode2, nodeOffset: 2, times: 1)
      XCTAssertEqual(selection3.focus.offset, 6)
    }
  }

  func testUpdateSelectionResolveTextNodes() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let editorState = getActiveEditorState(),
        let rootNode = editorState.getRootNode()
      else {
        XCTFail("should have editor state")
        return
      }
      let textNode = TextNode()
      try textNode.setText("hello")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let testNode1 = TextNode()
      let testNode2 = TextNode()
      let testNode3 = TextNode()
      try testNode1.setText("This is a new test.")
      try testNode2.setText("Checking selection between")
      try testNode3.setText("element types")

      let paragraphNode1 = ParagraphNode()

      try paragraphNode1.append([testNode1])
      try paragraphNode1.append([testNode2])
      try paragraphNode1.append([testNode3])

      try rootNode.append([paragraphNode])
      try rootNode.append([paragraphNode1])

      let startPoint = createPoint(key: textNode.key, offset: 3, type: .text)
      let endPoint = createPoint(key: textNode.key, offset: 3, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      try updateSelectionResolveTextNodes(selection: selection)
      XCTAssertEqual(selection.focus.offset, 3)

      let startPoint1 = createPoint(key: textNode.key, offset: 3, type: .text)
      let endPoint1 = createPoint(key: paragraphNode.key, offset: 4, type: .element)
      let selection1 = RangeSelection(anchor: startPoint1, focus: endPoint1, format: TextFormat())
      try updateSelectionResolveTextNodes(selection: selection1)
      XCTAssertEqual(selection1.focus.offset, 5)

      let startPoint2 = createPoint(key: paragraphNode.key, offset: 3, type: .element)
      let endPoint2 = createPoint(key: textNode2.key, offset: 4, type: .text)
      let selection2 = RangeSelection(anchor: startPoint2, focus: endPoint2, format: TextFormat())
      try updateSelectionResolveTextNodes(selection: selection2)
      XCTAssertEqual(selection2.focus.offset, 4)

      let startPoint3 = createPoint(key: paragraphNode.key, offset: 3, type: .element)
      let endPoint3 = createPoint(key: paragraphNode1.key, offset: 4, type: .element)
      let selection3 = RangeSelection(anchor: startPoint3, focus: endPoint3, format: TextFormat())
      try updateSelectionResolveTextNodes(selection: selection3)
      XCTAssertEqual(selection3.focus.offset, 13)
    }
  }

  func testMakeRangeSelection() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    view.textView.selectedRange = NSRange(location: 0, length: 5)

    try editor.update {
      let newSelection = try makeRangeSelection(
        anchorKey: "1",
        anchorOffset: 0,
        focusKey: "1",
        focusOffset: 5,
        anchorType: .text,
        focusType: .text)

      guard let selection = editor.testing_getPendingEditorState()?.selection as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }

      XCTAssertEqual(newSelection.anchor.key, "1")
      XCTAssertEqual(selection.anchor.key, "1")
      XCTAssertEqual(selection.focus.key, "1")
      XCTAssertEqual(selection.anchor.offset, 0)
      XCTAssertEqual(selection.focus.offset, 5)
      XCTAssertEqual(selection.anchor.type, SelectionType.text)
      XCTAssertEqual(selection.focus.type, SelectionType.text)
    }
  }

  func testRangeSelectionEquality() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    try editor.update {
      let newSelection = try makeRangeSelection(
        anchorKey: "1",
        anchorOffset: 0,
        focusKey: "1",
        focusOffset: 5,
        anchorType: .text,
        focusType: .text)

      editor.getEditorState().selection = newSelection
    }

    try editor.update {
      let newSelection2 = try makeRangeSelection(
        anchorKey: "1",
        anchorOffset: 0,
        focusKey: "1",
        focusOffset: 5,
        anchorType: .text,
        focusType: .text
      )

      XCTAssertTrue(editor.getEditorState().selection?.isSelection(newSelection2) ?? false)

      var textFormat = TextFormat()
      textFormat.bold = true
      newSelection2.format = textFormat

      XCTAssertFalse(editor.getEditorState().selection?.isSelection(newSelection2) ?? false)
    }
  }

  func testTransferStartingElementPointToTextPoint() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let startPoint = createPoint(key: paragraphNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: paragraphNode.key, offset: 0, type: .text)

      XCTAssertNoThrow(
        try transferStartingElementPointToTextPoint(
          start: startPoint,
          end: endPoint,
          format: TextFormat(),
          style: ""
        )
      )
    }
  }

  func testGetIndexFromPossibleClone() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let editorState = getActiveEditorState(),
        let rootNode = editorState.getRootNode()
      else {
        XCTFail("should have editor state")
        return
      }

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let textNode3 = TextNode()
      try textNode3.setText("again!")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])
      try paragraphNode.append([textNode3])

      try rootNode.append([paragraphNode])

      guard let nodeMap = editor.testing_getPendingEditorState()?.nodeMap else {
        XCTFail("Faied to get nodeMap")
        return
      }

      XCTAssertEqual(getIndexFromPossibleClone(node: textNode, parent: paragraphNode, nodeMap: nodeMap), 0)
      XCTAssertEqual(getIndexFromPossibleClone(node: textNode2, parent: paragraphNode, nodeMap: nodeMap), 1)
      XCTAssertEqual(getIndexFromPossibleClone(node: textNode3, parent: paragraphNode, nodeMap: nodeMap), 2)

      XCTAssertEqual(getIndexFromPossibleClone(node: textNode, parent: rootNode, nodeMap: nodeMap), nil)
    }
  }
}
