/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class SelectionTests: XCTestCase {

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

  func getSelectionAssumingRangeSelection() -> RangeSelection {
    let selection = try? getSelection()
    guard let selection = selection as? RangeSelection else {
      XCTFail("expected range selection, got \(String(describing: selection))")
      fatalError()
    }
    return selection
  }

  func testCloneSelection() throws {
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

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode2.key, offset: 4, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      guard let clonedNode = selection.clone() as? RangeSelection else {
        XCTFail("need cloned node")
        return
      }

      XCTAssertTrue(textNode.key == clonedNode.anchor.key, "Cloned object should have same key as TextNode")
    }
  }

  func testSetTextNodeRange() throws {
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

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode2.key, offset: 4, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      selection.setTextNodeRange(
        anchorNode: textNode,
        anchorOffset: 1,
        focusNode: textNode2,
        focusOffset: 3)
      XCTAssertTrue(selection.anchor.offset == 1)
      XCTAssertTrue(selection.focus.offset == 3)

      selection.setTextNodeRange(
        anchorNode: textNode,
        anchorOffset: 2,
        focusNode: textNode2,
        focusOffset: 5)
      XCTAssertTrue(selection.anchor.offset == 2)
      XCTAssertTrue(selection.focus.offset == 5)
    }
  }

  func testIsBackward() throws {
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

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode2.key, offset: 0, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      XCTAssert(try selection.isBackward() == false)

      let startPoint1 = createPoint(key: textNode.key, offset: 1, type: .text)
      let endPoint1 = createPoint(key: paragraphNode.key, offset: 0, type: .element)
      let selection1 = RangeSelection(anchor: startPoint1, focus: endPoint1, format: TextFormat())
      XCTAssert(try selection1.isBackward() == true)

      let startPoint2 = createPoint(key: textNode2.key, offset: 0, type: .text)
      let endPoint2 = createPoint(key: paragraphNode.key, offset: 1, type: .element)
      let selection2 = RangeSelection(anchor: startPoint2, focus: endPoint2, format: TextFormat())
      XCTAssert(try selection2.isBackward() == false)

      let startPoint3 = createPoint(key: textNode2.key, offset: 1, type: .text)
      let endPoint3 = createPoint(key: textNode.key, offset: 1, type: .text)
      let selection3 = RangeSelection(anchor: startPoint3, focus: endPoint3, format: TextFormat())
      XCTAssert(try selection3.isBackward() == true)
    }
  }

  func testIsCollapsed() throws {
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

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode2.key, offset: 0, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      XCTAssert(selection.isCollapsed() == false)

      let startPoint1 = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint1 = createPoint(key: textNode.key, offset: 0, type: .text)
      let selection1 = RangeSelection(anchor: startPoint1, focus: endPoint1, format: TextFormat())
      XCTAssert(selection1.isCollapsed() == true)
    }
  }

  func testInsertText() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      guard let paragraphNode = getRoot()?.getFirstChild() as? ParagraphNode else {
        XCTFail("Expected paragraph node")
        return
      }
      try paragraphNode.append([textNode])

      let endIndex = textNode.getTextPart().lengthAsNSString()

      let startPoint = createPoint(key: textNode.key, offset: endIndex, type: .text)
      let endPoint = createPoint(key: textNode.key, offset: endIndex, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      try selection.insertText("Test")

      XCTAssertEqual(textNode.getTextPart(), "hello Test")
    }
  }

  func testInsertTextWithinBoldParagraph() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    XCTAssertEqual(view.textView.text, "")
    view.textView.selectedRange = NSRange(location: 0, length: 0)
    view.textView.insertText("1")
    XCTAssertEqual(view.textView.text, "1")

    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        return
      }

      let paragraphNode = ParagraphNode()
      try rootNode.append([paragraphNode])

      let textNode = TextNode()
      try textNode.setText("Hello World! ")
      try paragraphNode.append([textNode])

      let textNode2 = TextNode()
      try textNode2.setText("Welcome to Lexical iOS!")
      try textNode2.setBold(true)
      try paragraphNode.append([textNode2])
    }
    view.textView.selectedRange = NSRange(location: 17, length: 0)
    view.textView.insertText("T")
    XCTAssertEqual(view.textView.text, "1\nHello World! WeTlcome to Lexical iOS!")
  }

  // TODO: @amyworrall I'm disabling these two tests for now -- I broke something when fixing the autocomplete support.
  // I'll come back to these when I finish my work on marked text.

  //  func testInsertTextCanTypeHiragana() throws {
  //    let textView = TextView()
  //    let editor = textView.editor
  //    editor.textStorage = TextStorage()
  //
  //    try editor.update {
  //      let textNode = TextNode()
  //      let paragraphNode = ParagraphNode()
  //      try paragraphNode.append([textNode])
  //
  //      let endIndex = textNode.getTextPart().lengthAsNSString()
  //
  //      let startPoint = createPoint(key: textNode.key, offset: endIndex, type: .text)
  //      let endPoint = createPoint(key: textNode.key, offset: endIndex, type: .text)
  //      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
  //
  //      textView.setMarkedText("s", selectedRange: NSRange(location: 0, length: 1))
  //      textView.setMarkedText("す", selectedRange: NSRange(location: 0, length: 1))
  //      textView.setMarkedText("すｓ", selectedRange: NSRange(location: 1, length: 1))
  //      textView.setMarkedText("すｓｈ", selectedRange: NSRange(location: 2, length: 2))
  //      textView.setMarkedText("すし", selectedRange: NSRange(location: 0, length: 2))
  //
  //      try selection.insertText(textView.text ?? "")
  //      try selection.insertText(" ")
  //
  //      textView.setMarkedText("m", selectedRange: NSRange(location: 0, length: 1))
  //      textView.setMarkedText("も", selectedRange: NSRange(location: 0, length: 1))
  //      textView.setMarkedText("もj", selectedRange: NSRange(location: 1, length: 1))
  //      textView.setMarkedText("もじ", selectedRange: NSRange(location: 1, length: 1))
  //      textView.setMarkedText("もじあ", selectedRange: NSRange(location: 2, length: 1))
  //
  //      try selection.insertText(textView.text ?? "")
  //
  //      XCTAssertTrue(textNode.getTextPart() == "すし もじあ")
  //    }
  //  }
  //
  //  func testInsertTextCanTypeHiraganaBetweenLineBreaks() throws {
  //    let textView = TextView()
  //    let editor = textView.editor
  //    editor.textStorage = TextStorage()
  //
  //    try editor.update {
  //      let textNode = TextNode()
  //      let paragraphNode = ParagraphNode()
  //      try paragraphNode.append([textNode])
  //
  //      let endIndex = textNode.getTextPart().lengthAsNSString()
  //
  //      let startPoint = createPoint(key: textNode.key, offset: endIndex, type: .text)
  //      let endPoint = createPoint(key: textNode.key, offset: endIndex, type: .text)
  //      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
  //
  //      try selection.insertText("\n")
  //      try selection.insertText("\n")
  //
  //      editor.moveNativeSelection(type: .move, direction: .backward, granularity: .character)
  //
  //      textView.setMarkedText("s", selectedRange: NSRange(location: 0, length: 1))
  //      textView.setMarkedText("す", selectedRange: NSRange(location: 0, length: 1))
  //      textView.setMarkedText("すｓ", selectedRange: NSRange(location: 1, length: 1))
  //      textView.setMarkedText("すｓｈ", selectedRange: NSRange(location: 2, length: 2))
  //      textView.setMarkedText("すし", selectedRange: NSRange(location: 0, length: 2))
  //
  //      try selection.insertText(textView.text ?? "")
  //      try selection.insertText(" ")
  //
  //      textView.setMarkedText("m", selectedRange: NSRange(location: 0, length: 1))
  //      textView.setMarkedText("も", selectedRange: NSRange(location: 0, length: 1))
  //      textView.setMarkedText("もj", selectedRange: NSRange(location: 1, length: 1))
  //      textView.setMarkedText("もじ", selectedRange: NSRange(location: 1, length: 1))
  //      textView.setMarkedText("もじあ", selectedRange: NSRange(location: 2, length: 1))
  //
  //      try selection.insertText(textView.text ?? "")
  //
  //      XCTAssertTrue(textNode.getTextPart() == "\nすし もじあ\n")
  //    }
  //  }

  func testGetNodes() throws {
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
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      let selectedNodes = try selection.getNodes()

      XCTAssert(selectedNodes.count == 1)
      XCTAssert(selectedNodes[0].key == textNode.key)
    }
  }

  func testApplyNativeSelection() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    var nativeSelection = NativeSelection(range: NSRange(location: 0, length: 8), affinity: .forward)

    try editor.update {
      try getSelectionAssumingRangeSelection().applyNativeSelection(nativeSelection)
      let newSelection = getSelectionAssumingRangeSelection()
      XCTAssertEqual(newSelection.anchor.key, "1")
      XCTAssertEqual(newSelection.focus.key, "2")
      XCTAssertEqual(newSelection.anchor.offset, 0)
      XCTAssertEqual(newSelection.focus.offset, 2)
      XCTAssertEqual(newSelection.anchor.type, SelectionType.text)
      XCTAssertEqual(newSelection.focus.type, SelectionType.text)

      nativeSelection = NativeSelection(range: NSRange(location: 3, length: 0), affinity: .forward)

      try getSelectionAssumingRangeSelection().applyNativeSelection(nativeSelection)
      let newSelection2 = getSelectionAssumingRangeSelection()
      XCTAssertEqual(newSelection2.anchor.key, "1")
      XCTAssertEqual(newSelection2.focus.key, "1")
      XCTAssertEqual(newSelection2.anchor.offset, 3)
      XCTAssertEqual(newSelection2.focus.offset, 3)
      XCTAssertEqual(newSelection2.anchor.type, SelectionType.text)
      XCTAssertEqual(newSelection2.focus.type, SelectionType.text)

      nativeSelection = NativeSelection(range: NSRange(location: 5, length: 2), affinity: .forward)

      try getSelectionAssumingRangeSelection().applyNativeSelection(nativeSelection)
      let newSelection3 = getSelectionAssumingRangeSelection()
      XCTAssertEqual(newSelection3.anchor.key, "1")
      XCTAssertEqual(newSelection3.focus.key, "2")
      XCTAssertEqual(newSelection3.anchor.offset, 5)
      XCTAssertEqual(newSelection3.focus.offset, 1)
      XCTAssertEqual(newSelection3.anchor.type, SelectionType.text)
      XCTAssertEqual(newSelection3.focus.type, SelectionType.text)

      nativeSelection = NativeSelection(range: NSRange(location: 4, length: 6), affinity: .forward)

      try getSelectionAssumingRangeSelection().applyNativeSelection(nativeSelection)
      let newSelection4 = getSelectionAssumingRangeSelection()
      XCTAssertEqual(newSelection4.anchor.key, "1")
      XCTAssertEqual(newSelection4.focus.key, "2")
      XCTAssertEqual(newSelection4.anchor.offset, 4)
      XCTAssertEqual(newSelection4.focus.offset, 4)
      XCTAssertEqual(newSelection4.anchor.type, SelectionType.text)
      XCTAssertEqual(newSelection4.focus.type, SelectionType.text)
    }
  }

  func testExtract() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let textNode3 = TextNode()
      try textNode3.setText("again")

      let paragraphNode = ParagraphNode()
      try getRoot()?.append([paragraphNode])

      var startPoint = createPoint(key: paragraphNode.key, offset: 0, type: .text)
      var endPoint = createPoint(key: paragraphNode.key, offset: 0, type: .text)
      var selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      var extractedNodes = try selection.extract()

      XCTAssertEqual(extractedNodes.count, 1, "should have one (empty) paragraph node")

      try paragraphNode.append([textNode])
      extractedNodes = try selection.extract()

      XCTAssertEqual(extractedNodes.count, 1)

      try paragraphNode.append([textNode2, textNode3])

      startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      endPoint = createPoint(key: textNode3.key, offset: 0, type: .text)
      selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      extractedNodes = try selection.extract()

      XCTAssertEqual(extractedNodes.count, 2)
      XCTAssert(extractedNodes[0].key == textNode.key)
    }
  }

  func testInsertParagraph() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        XCTFail("should have editor state")
        return
      }

      let textNode = TextNode()
      try textNode.setText("hello world")

      let textNode2 = TextNode()
      try textNode2.setText("again")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])
      try rootNode.append([paragraphNode])

      var startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      var endPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      var selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      XCTAssertEqual(paragraphNode.children.count, 2)

      try selection.insertParagraph()
      let insertedParaKey: NodeKey = "\(Int(editor.keyCounter) - 1)"

      XCTAssertEqual(selection.anchor.offset, 0)
      XCTAssertEqual(selection.focus.offset, 0)
      XCTAssertEqual(selection.anchor.type, SelectionType.text)
      XCTAssertEqual(selection.focus.type, SelectionType.text)
      XCTAssertEqual(paragraphNode.children.count, 2, "paragraphNode should have 2 children")
      if let newParagraphNode = getNodeByKey(key: insertedParaKey) as? ParagraphNode {
        XCTAssertEqual(newParagraphNode.children.count, 0, "newParagraphNode should have 0 children")
        XCTAssertEqual(newParagraphNode.parent, "root")
      }

      // we now have an empty paragraph before the paragraph saying "hello worldagain"

      startPoint = createPoint(key: textNode.key, offset: 6, type: .text) // just before "world"
      endPoint = createPoint(key: textNode.key, offset: 6, type: .text)
      selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      // inserts a paragraph(key 6)
      try selection.insertParagraph()
      let nextInsertedParaKey: NodeKey = "\(Int(editor.keyCounter) - 1)"

      guard let selection = try getSelection() as? RangeSelection else {
        XCTFail()
        return
      }

      XCTAssertEqual(selection.anchor.offset, 0)
      XCTAssertEqual(selection.focus.offset, 0)
      XCTAssertEqual(selection.anchor.type, SelectionType.text)
      XCTAssertEqual(selection.focus.type, SelectionType.text)
      if let newParagraphNode = getNodeByKey(key: paragraphNode.key) as? ParagraphNode {
        XCTAssertEqual(newParagraphNode.children.count, 1, "paragraphNode should have 1 child")
        XCTAssertEqual(newParagraphNode.children[0], textNode.key)
      }

      if let newParagraphNode = getNodeByKey(key: nextInsertedParaKey) as? ParagraphNode {
        XCTAssertEqual(newParagraphNode.children.count, 2, "paragraphNode should have 2 children")
        XCTAssertEqual(newParagraphNode.children[1], textNode2.key)
        XCTAssertEqual(newParagraphNode.parent, "root")
      }
    }
  }

  func testTypeTwoWordsSeparatedByWhiteSpace() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("text node 1")

      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        XCTFail("should have editor state")
        return
      }

      XCTAssertNotNil(rootNode)
      XCTAssertEqual(rootNode.children.count, 1)

      guard let paragraphNode = rootNode.getFirstChild() as? ParagraphNode else {
        XCTFail("failed getting paragarph node from root")
        return
      }

      XCTAssertNotNil(paragraphNode)
      XCTAssertEqual(paragraphNode.children.count, 0)

      var startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      var endPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      var selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      try selection.insertText("replacement text")
      var nodes = try selection.getNodes()

      if nodes.isEmpty {
        XCTFail("No nodes")
      }

      for node in nodes {
        XCTAssertEqual(node.getTextPart(), "replacement text")
      }

      startPoint = createPoint(key: textNode.key, offset: 16, type: .text)
      endPoint = createPoint(key: textNode.key, offset: 16, type: .text)
      selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      try selection.insertText(" Hello world")
      nodes = try selection.getNodes()

      if nodes.isEmpty {
        XCTFail("No nodes")
      }

      for node in nodes {
        XCTAssertEqual(node.getTextPart(), "replacement text Hello world")
      }

      XCTAssertEqual(selection.anchor.offset, 16)
      XCTAssertEqual(selection.focus.offset, 16)
    }
  }

  func testTypeSentenceMoveCaretToMiddle() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    let beginning = view.textView.beginningOfDocument
    let ending = view.textView.endOfDocument

    guard let originalPoint = view.textView.position(from: beginning, offset: 10) else {
      XCTFail("")
      return
    }

    guard let newPoint = view.textView.position(from: beginning, offset: 15) else {
      XCTFail("")
      return
    }

    let originalRange = view.textView.textRange(from: originalPoint, to: ending)
    let newRange = view.textView.textRange(from: newPoint, to: newPoint)

    view.textView.selectedTextRange = originalRange

    try editor.update {
      guard let selection = try createSelection(editor: editor) as? RangeSelection else {
        XCTFail()
        return
      }

      XCTAssertEqual(selection.anchor.offset, 4)
      XCTAssertEqual(selection.focus.offset, 11)
      XCTAssertEqual(selection.focus.key, "6")
      XCTAssertEqual(selection.anchor.key, "2")
    }

    view.textView.selectedTextRange = newRange

    try editor.update {
      guard let selection = try createSelection(editor: editor) as? RangeSelection else {
        XCTFail()
        return
      }

      XCTAssertEqual(selection.anchor.offset, 3)
      XCTAssertEqual(selection.focus.offset, 3)
      XCTAssertEqual(selection.focus.key, "3")
      XCTAssertEqual(selection.anchor.key, "3")
    }
  }

  func testTypeTwoWordsSeparatedByWhiteSpaceAndDeleteFromEndOfWhitespace() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()

      guard let paragraphNode = getRoot()?.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }

      try paragraphNode.append([textNode])

      var startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      var endPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      var selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      try selection.insertText("Hello world")

      startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      endPoint = createPoint(key: textNode.key, offset: 6, type: .text)
      selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      try selection.insertText("")
      let nodes = try selection.getNodes()

      if nodes.isEmpty {
        XCTFail("No nodes")
      }

      for node in nodes {
        XCTAssertEqual(node.getTextPart(), "world")
      }

      XCTAssertEqual(selection.anchor.offset, 0)
      XCTAssertEqual(selection.focus.offset, 6)
    }
  }

  func testReplaceParagraphBoundary() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("123")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      let textNode2 = TextNode()
      try textNode2.setText("456")

      let paragraphNode2 = ParagraphNode()
      try paragraphNode2.append([textNode2])

      let paragraphNode3 = ParagraphNode()

      guard let rootNode = editor.getEditorState().getRootNode() else {
        XCTFail("No Root node Found")
        return
      }

      try rootNode.append([paragraphNode, paragraphNode2, paragraphNode3])

      let startPoint = createPoint(key: textNode2.key, offset: 3, type: .text)
      let endPoint = createPoint(key: paragraphNode3.key, offset: 0, type: .element)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      try selection.insertText("")
    }

    XCTAssert((editor.textStorage?.string ?? "") == "\n123\n456", "Final text did not match expected state")
  }

  // @alexmattice, @amyworrall - This is to test known edge cases around selection mods in updates
  //  func testDeleteBackwardsParagraphBoundary() throws {
  //    let editor = Editor()
  //    editor.textStorage = TextStorage()
  //
  //    try editor.update {
  //      let textNode = TextNode()
  //      try textNode.setText("123")
  //
  //      let paragraphNode = ParagraphNode()
  //      try paragraphNode.append([textNode])
  //
  //      let textNode2 = TextNode()
  //      try textNode2.setText("456")
  //
  //      let paragraphNode2 = ParagraphNode()
  //      try paragraphNode2.append([textNode2])
  //
  //      let paragraphNode3 = ParagraphNode()
  //
  //      guard let rootNode = editor.getEditorState().getRootNode() else {
  //        XCTFail("No Root node Found")
  //        return
  //      }
  //
  //      try rootNode.append([paragraphNode, paragraphNode2, paragraphNode3])
  //
  //      let startPoint = createPoint(key: paragraphNode3.key, offset: 0, type: .element)
  //      let endPoint = createPoint(key: paragraphNode3.key, offset: 0, type: .element)
  //      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
  //
  //      try selection.deleteCharacter(isBackwards: true)
  //    }
  //
  //    XCTAssert((editor.textStorage?.string ?? "") == "\n123\n456", "Final text did not match expected state")
  //  }

  func testDeleteTextAcrossTwoNodes() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let textView = view.textView

    textView.insertText("Hello world")
    XCTAssertEqual(textView.text, "Hello world", "Expected hello world")
    textView.insertText("\n")
    XCTAssertEqual(textView.text, "Hello world\n", "Expected hello world")
    textView.insertText("here's para 2")
    XCTAssertEqual(textView.text, "Hello world\nhere's para 2", "Expected hello world")
    textView.selectedRange = NSRange(location: 5, length: 9)
    textView.deleteBackward()
    XCTAssertEqual(textView.text, "Hellore's para 2", "Reading via UIKit should work")

    try textView.editor.getEditorState().read {
      guard let node = getActiveEditorState()?.getRootNode()?.getFirstDescendant() as? TextNode else {
        XCTFail()
        return
      }
      XCTAssertEqual(node.getTextPart(), "Hellore's para 2", "Reading via Lexical should work")
    }
  }

  func testFormatText() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      var selection = getSelectionAssumingRangeSelection()

      try selection.insertText("I am testing to verify format updates!!")
      XCTAssertEqual(editor.testing_getPendingEditorState()?.nodeMap.count, 3)

      let start = createPoint(key: "1", offset: 5, type: .text)
      let end = createPoint(key: "1", offset: 15, type: .text)
      selection = RangeSelection(anchor: start, focus: end, format: TextFormat())
      XCTAssertEqual(selection.format.bold, false)

      try selection.formatText(formatType: .bold)
      XCTAssertEqual(selection.format.bold, true)
    }

    try editor.read {
      // 2 new textNodes should have been created
      var textNodes = editor.getEditorState().nodeMap.values.filter { $0.type == NodeType.text && $0.parent != nil }
      textNodes = textNodes.sorted(by: { $0.key < $1.key })

      XCTAssertEqual(textNodes.count, 3)
      XCTAssertEqual(textNodes[0].getTextPart(), "I am ")
      XCTAssertEqual(textNodes[1].getTextPart(), "testing to")
      XCTAssertEqual(textNodes[2].getTextPart(), " verify format updates!!")

      guard let textNode0 = textNodes[0] as? TextNode,
        let textNode1 = textNodes[1] as? TextNode,
        let textNode2 = textNodes[2] as? TextNode
      else {
        XCTFail("Failed to extract the textNodes")
        return
      }

      XCTAssertEqual(textNode0.format.bold, false)
      XCTAssertEqual(textNode1.format.bold, true)
      XCTAssertEqual(textNode2.format.bold, false)
    }

    try editor.update {
      try updateTextFormat(type: .italic, editor: editor)
      XCTAssertEqual(getSelectionAssumingRangeSelection().format.italic, true)
      XCTAssertEqual(getSelectionAssumingRangeSelection().format.bold, true)
    }
  }

  func testFormatTextAcrossMultipleParagraphs() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      var selection = getSelectionAssumingRangeSelection()

      try selection.insertText("Hello!")
      XCTAssertEqual(editor.testing_getPendingEditorState()?.nodeMap.count, 3, "Expected pending node map to have 3 nodes")
      XCTAssertEqual(selection.anchor.offset, 6)
      XCTAssertEqual(selection.focus.offset, 6)

      try selection.insertParagraph()
      try selection.insertText("This is a new test")
      let start = createPoint(key: "1", offset: 4, type: .text)
      let end = createPoint(key: "3", offset: 7, type: .text)
      selection = RangeSelection(anchor: start, focus: end, format: TextFormat())
      XCTAssertEqual(selection.format.bold, false)

      try selection.formatText(formatType: .bold)
      XCTAssertEqual(selection.anchor.offset, 0)
      XCTAssertEqual(selection.focus.offset, 7)
      XCTAssertEqual(selection.format.bold, true)
    }

    try editor.read {
      // 2 new textNodes should have been created
      print("\(String(describing: getActiveEditorState()?.nodeMap))")
      var textNodes = editor.getEditorState().nodeMap.values.filter { $0.type == NodeType.text && $0.parent != nil }
      textNodes = textNodes.sorted(by: { $0.key < $1.key })

      XCTAssertEqual(textNodes.count, 4, "Expected 4 text nodes")
      XCTAssertEqual(textNodes[0].getTextPart(), "Hell")
      XCTAssertEqual(textNodes[2].getTextPart(), "o!")
      XCTAssertEqual(textNodes[1].getTextPart(), "This is")
      XCTAssertEqual(textNodes[3].getTextPart(), " a new test")
      XCTAssertEqual(textNodes[0].parent, textNodes[2].parent)
      XCTAssertEqual(textNodes[1].parent, textNodes[3].parent)

      let paragraphNodes = editor.getEditorState().nodeMap.values.filter { $0.type == NodeType.paragraph }
      XCTAssertEqual(paragraphNodes.count, 2, "Expected two paragraph nodes")
    }
  }

  func testInsertNodes() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let editorState = editor.getEditorState()

      guard let rootNode = editorState.getRootNode() else {
        XCTFail("No root node present")
        return
      }

      guard let paragraphNode = rootNode.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      try textNode2.setBold(true)

      try paragraphNode.append([textNode])

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode.key, offset: 1, type: .text)

      let selection = getSelectionAssumingRangeSelection()

      selection.anchor = startPoint
      selection.focus = endPoint

      XCTAssertTrue(try selection.insertNodes(nodes: [textNode2], selectStart: false))
    }
  }

  func testGeneratePlaintextFromSelection() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      let selection = getSelectionAssumingRangeSelection()

      try selection.insertText("Hello!")
      try selection.insertParagraph()
      try selection.insertText("This is a new test")
      try selection.insertParagraph()

      selection.anchor.updatePoint(key: "1", offset: 0, type: .text) // the "Hello!" text node
      selection.focus.updatePoint(key: "4", offset: 0, type: .element) // the empty paragraph at the end
    }

    // In a future diff when this is not driven off the text storage, the range selection should
    // be tested in the same read/update loop.
    try editor.update {
      let selection = getSelectionAssumingRangeSelection()

      XCTAssertNotNil(try selection.getPlaintext())
      XCTAssertNoThrow(try selection.getPlaintext())
      XCTAssertEqual(
        try selection.getPlaintext(),
        "Hello!\nThis is a new test\n"
      )
    }
  }

  func testFormatTextWithDifferentFormatsOnDifferentNodes() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      var selection = getSelectionAssumingRangeSelection()

      try selection.insertText("I am testing to verify format updates!!")
      XCTAssertEqual(editor.testing_getPendingEditorState()?.nodeMap.count, 3)

      let start = createPoint(key: "1", offset: 5, type: .text)
      let end = createPoint(key: "1", offset: 15, type: .text)
      selection = RangeSelection(anchor: start, focus: end, format: TextFormat())
      XCTAssertEqual(selection.format.bold, false)

      // make "testing to" to bold
      try selection.formatText(formatType: .bold)
      XCTAssertEqual(selection.format.bold, true)
    }

    // make "ing to verify" underlined
    try editor.update {
      var selection = getSelectionAssumingRangeSelection()

      let start = createPoint(key: "3", offset: 4, type: .text)
      let end = createPoint(key: "4", offset: 7, type: .text)
      selection = RangeSelection(anchor: start, focus: end, format: TextFormat())
      XCTAssertEqual(selection.format.bold, false)

      try selection.formatText(formatType: .underline)
      XCTAssertEqual(selection.format.underline, true)
    }

    try editor.read {
      // 5 textNodes should be present
      var textNodes = editor.getEditorState().nodeMap.values.filter { $0.type == NodeType.text && $0.parent != nil }
      textNodes = textNodes.sorted(by: { $0.key < $1.key })

      XCTAssertEqual(textNodes.count, 5)
      XCTAssertEqual(textNodes[0].getTextPart(), "I am ")
      XCTAssertEqual(textNodes[1].getTextPart(), "test")
      XCTAssertEqual(textNodes[2].getTextPart(), " verify")
      XCTAssertEqual(textNodes[3].getTextPart(), "ing to")
      XCTAssertEqual(textNodes[4].getTextPart(), " format updates!!")

      // "I am" should not have any format
      if let textNode = textNodes[0] as? TextNode {
        XCTAssertFalse(textNode.format.bold)
      }

      // "test" should be bold
      if let textNode = textNodes[1] as? TextNode {
        XCTAssertTrue(textNode.format.bold)
      }

      // " verify" should be underlined
      if let textNode = textNodes[2] as? TextNode {
        XCTAssertTrue(textNode.format.underline)
        XCTAssertFalse(textNode.format.bold)
      }

      // "ing to" should bold and underline
      if let textNode = textNodes[3] as? TextNode {
        XCTAssertTrue(textNode.format.bold)
        XCTAssertTrue(textNode.format.underline)
      }

      //  "format updates !!" shouldn't have any format
      if let textNode = textNodes[4] as? TextNode {
        XCTAssertFalse(textNode.format.bold)
        XCTAssertFalse(textNode.format.underline)
      }
    }

    // make the whole selection bold
    try editor.update {
      var selection = getSelectionAssumingRangeSelection()

      let start = createPoint(key: "6", offset: 0, type: .text)
      let end = createPoint(key: "4", offset: 7, type: .text)
      selection = RangeSelection(anchor: start, focus: end, format: TextFormat())

      try selection.formatText(formatType: .bold)
    }

    try editor.read {
      // 4 textNodes should be present
      var textNodes = editor.getEditorState().nodeMap.values.filter { $0.type == NodeType.text && $0.parent != nil }
      textNodes = textNodes.sorted(by: { $0.key < $1.key })

      XCTAssertEqual(textNodes.count, 4)
      XCTAssertEqual(textNodes[0].getTextPart(), "I am ")
      XCTAssertEqual(textNodes[1].getTextPart(), "test")
      XCTAssertEqual(textNodes[2].getTextPart(), "ing to verify")
      XCTAssertEqual(textNodes[3].getTextPart(), " format updates!!")

      // "I am" should not have any format
      if let textNode = textNodes[0] as? TextNode {
        XCTAssertFalse(textNode.format.bold)
      }

      // "test" should be bold
      if let textNode = textNodes[1] as? TextNode {
        XCTAssertTrue(textNode.format.bold)
      }

      // "ing to verify" should be underlined but not bold
      if let textNode = textNodes[2] as? TextNode {
        XCTAssertTrue(textNode.format.underline)
        XCTAssertFalse(textNode.format.bold)
      }

      //  "format updates !!" shouldn't have any format
      if let textNode = textNodes[3] as? TextNode {
        XCTAssertFalse(textNode.format.bold)
        XCTAssertFalse(textNode.format.underline)
      }
    }
  }

  func testInsertNewLineAtBeginningOfHeadingNode() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let rootNode = editor.getEditorState().nodeMap[kRootNodeKey] as? RootNode else {
        XCTFail("Failed to get rootNode")
        return
      }

      let headingNode = HeadingNode(tag: .h1) // key 1
      let textNode = TextNode() // key 2
      try textNode.setText("This is H1")
      try headingNode.append([textNode])
      try rootNode.append([headingNode])

      let anchor = Point(key: "2", offset: 0, type: .text)
      let focus = Point(key: "2", offset: 0, type: .text)
      let selection = RangeSelection(anchor: anchor, focus: focus, format: TextFormat())
      try selection.insertParagraph()
    }

    try editor.read {
      let nodeMap = editor.getEditorState().nodeMap

      guard let textNode = nodeMap["2"],
        let parentKey = textNode.parent,
        let parent = getNodeByKey(key: parentKey) as? HeadingNode
      else {
        XCTFail("Failed to retain the heading node")
        return
      }

      XCTAssertEqual(parent.key, "1")
      XCTAssertEqual(parent.getTag(), HeadingTagType.h1)
      XCTAssertEqual(textNode.getTextPart(), "This is H1")

      if let newParagraph = nodeMap["3"] {
        XCTAssertTrue(newParagraph is ParagraphNode)
      } else {
        XCTFail("Failed to create new paragraph node")
      }
    }
  }

  func testDeletingAtBeginningOfParagraphWithMultipleTextNodes() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let paragraphNode = getNodeByKey(key: "0") as? ParagraphNode else { return }

      let textNode = TextNode() // key 1
      try textNode.setText("Hello world again")
      try paragraphNode.append([textNode])

      let anchor = Point(key: "1", offset: 12, type: .text)
      let focus = Point(key: "1", offset: 17, type: .text)
      let selection = RangeSelection(anchor: anchor, focus: focus, format: TextFormat())
      try selection.formatText(formatType: .bold) // key 2 with text = again

      let newAnchor = Point(key: "1", offset: 6, type: .text)
      let newFocus = Point(key: "1", offset: 6, type: .text)
      let newSelection = RangeSelection(anchor: newAnchor, focus: newFocus, format: TextFormat())
      try newSelection.insertParagraph() // key 4 - paragraph with 2 children
    }

    try editor.update {
      let selection = getSelectionAssumingRangeSelection()

      XCTAssertEqual(selection.anchor.key, "5")
      XCTAssertEqual(selection.focus.key, "5")
      XCTAssertEqual(selection.anchor.type, SelectionType.text)
      XCTAssertEqual(selection.anchor.type, SelectionType.text)

      try selection.deleteCharacter(isBackwards: true)
    }

    try editor.read {
      guard let paragraphNode = getNodeByKey(key: "0") as? ParagraphNode else { return }
      XCTAssertEqual(paragraphNode.children.count, 2)

      guard let textNode1 = getNodeByKey(key: paragraphNode.children[0]) as? TextNode,
        let textNode2 = getNodeByKey(key: paragraphNode.children[1]) as? TextNode
      else { return }

      XCTAssertEqual(textNode1.getTextPart(), "Hello world ")
      XCTAssertEqual(textNode2.getTextPart(), "again")
      XCTAssertTrue(textNode2.format.bold)
    }
  }

  func testApplyNativeSelectionWithBackwardAffinity() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    var nativeSelection = NativeSelection(range: NSRange(location: 10, length: 10), affinity: .backward)

    try editor.update {
      try getSelectionAssumingRangeSelection().applyNativeSelection(nativeSelection)
      let newSelection = getSelectionAssumingRangeSelection()
      XCTAssertEqual(newSelection.anchor.key, "3")
      XCTAssertEqual(newSelection.focus.key, "2")
      XCTAssertEqual(newSelection.anchor.offset, 8)
      XCTAssertEqual(newSelection.focus.offset, 4)
      XCTAssertEqual(newSelection.anchor.type, SelectionType.text)
      XCTAssertEqual(newSelection.focus.type, SelectionType.text)
    }

    nativeSelection = NativeSelection(range: NSRange(location: 26, length: 30), affinity: .backward)

    try editor.update {
      try getSelectionAssumingRangeSelection().applyNativeSelection(nativeSelection)
      let newSelection = getSelectionAssumingRangeSelection()
      XCTAssertEqual(newSelection.anchor.key, "6")
      XCTAssertEqual(newSelection.focus.key, "3")
      XCTAssertEqual(newSelection.anchor.offset, 4)
      XCTAssertEqual(newSelection.focus.offset, 14)
      XCTAssertEqual(newSelection.anchor.type, SelectionType.text)
      XCTAssertEqual(newSelection.focus.type, SelectionType.text)
    }
  }

  func testInsertLineBreak() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    view.textView.insertText("Hello!")

    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        return
      }

      let textNode = TextNode()
      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try rootNode.append([paragraphNode])

      let endIndex = textNode.getTextPart().lengthAsNSString()

      let startPoint = createPoint(key: textNode.key, offset: endIndex, type: .text)
      let endPoint = createPoint(key: textNode.key, offset: endIndex, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())

      try selection.insertText("Welcome to Lexical iOS")
      XCTAssertEqual(view.textView.text, "Hello!")
      try selection.insertLineBreak(selectStart: true)
    }
    XCTAssertEqual(view.textView.text, "Hello!\n\nWelcome to Lexical iOS")
  }

  func testGetTextContent() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    view.textView.insertText("Hello 🇺🇸, How are you doing?")
    let anchor = Point(key: "1", offset: 5, type: .text)
    let focus = Point(key: "1", offset: 10, type: .text)
    let selection = RangeSelection(anchor: anchor, focus: focus, format: TextFormat())

    try editor.read {
      let textContent = try selection.getTextContent()
      XCTAssertEqual(textContent, " 🇺🇸")
    }
  }
}
