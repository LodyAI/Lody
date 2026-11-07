/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class ReconcilerTests: XCTestCase {

  func testRangeCacheHasEmptyItemForNewRootNode() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor
    XCTAssertNotNil(editor.rangeCache[kRootNodeKey])
  }

  func testHelloWorld() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor
    XCTAssertEqual(editor.textStorage?.string, "")

    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail()
        return
      }

      guard let paragraphNode = rootNode.getFirstChild() as? ParagraphNode else {
        XCTFail("Couldn't get paragraph node")
        return
      }

      let textNode = TextNode()
      try textNode.setText("Hello ")
      try textNode.setBold(true)
      try paragraphNode.append([textNode])

      let textNode2 = TextNode()
      try textNode2.setText("world!")
      try paragraphNode.append([textNode2])
    }
    XCTAssertEqual(editor.textStorage?.string, "Hello world!")
  }

  func testRemoveOldAddNew() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor
    XCTAssertEqual(editor.textStorage?.string, "")

    var childNodeKey: NodeKey?
    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail("Was not able to get editor state and root node")
        return
      }

      guard let paragraphNode = rootNode.getFirstChild() as? ParagraphNode else {
        XCTFail("Couldn't get paragraph node")
        return
      }

      let textNode = TextNode()
      try textNode.setText("Hello ")
      try textNode.setBold(true)
      try paragraphNode.append([textNode])

      let textNode2 = TextNode()
      try textNode2.setText("world!")
      try paragraphNode.append([textNode2])
      childNodeKey = textNode2.getKey()
    }
    XCTAssertEqual(editor.textStorage?.string, "Hello world!")

    try editor.update {
      guard let childNodeKey, let childNode = getNodeByKey(key: childNodeKey) as? TextNode else {
        XCTFail()
        return
      }
      try childNode.setText("everyone!")
    }
    XCTAssertEqual(editor.textStorage?.string, "Hello everyone!")
  }

  func testDidMarkParentNodesDirty() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor
    XCTAssertEqual(editor.textStorage?.string, "")

    var childNode: TextNode?
    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail("Was not able to get editor state and root node")
        return
      }

      guard let paragraphNode = rootNode.getFirstChild() as? ParagraphNode else {
        XCTFail("Couldn't get paragraph node")
        return
      }

      let textNode = TextNode()
      try textNode.setText("Hello ")
      try paragraphNode.append([textNode])

      let textNode2 = TextNode()
      try textNode2.setText("world!")
      try textNode2.setBold(true)
      try paragraphNode.append([textNode2])
      childNode = textNode2
    }
    XCTAssertEqual(editor.textStorage?.string, "Hello world!")

    try editor.update {
      guard let childNode: TextNode = try childNode?.getWritable() else {
        XCTFail("Was not able to get writable child node")
        return
      }

      try childNode.setText("everyone!")

      XCTAssertTrue(editor.dirtyNodes["root"] != nil, "Root was not marked dirty")
      XCTAssertTrue(editor.dirtyNodes[childNode.key] != nil, "Child was not marked dirty")
    }
  }

  func testDidMarkSiblingNodesDirty() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail("Was not able to get editor state and root node")
        return
      }

      let textNode = TextNode()
      try textNode.setText("Hello ")
      try rootNode.append([textNode])

      let textNode2 = TextNode()
      try textNode2.setText("world ")
      try rootNode.append([textNode2])

      let textNode3 = TextNode()
      try textNode3.setText("test")
      try rootNode.append([textNode3])

      internallyMarkSiblingsAsDirty(node: textNode2)

      XCTAssertTrue(editor.dirtyNodes[textNode.key] != nil)
      XCTAssertTrue(editor.dirtyNodes[textNode3.key] != nil)
    }
  }

  func testMultipleUpdates() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail()
        return
      }
      guard let pNode = rootNode.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }

      let tNode1 = TextNode(text: "A", key: nil)
      try tNode1.setBold(true)
      XCTAssertEqual(tNode1.key, "1", "Unexpected node key")
      try pNode.append([tNode1])

      let tNode2 = TextNode(text: "B", key: nil)
      try pNode.append([tNode2])
      XCTAssertEqual(pNode.getChildren().count, 2, "Expected two children on main para node")
    }
    try editor.update {}
    XCTAssertEqual("AB", view.textStorage.string, "Text should be AB")
    try editor.update {
      guard let node = getNodeByKey(key: "1") as? TextNode else {
        XCTFail("Couldn't find node")
        return
      }
      try node.setText("C")
    }
    XCTAssertEqual("CB", view.textStorage.string, "Should be CB")
    try editor.update {}

    try editor.update {
      guard let editor = getActiveEditor(), let pNode: ParagraphNode = try getNodeByKey(key: "0")?.getWritable() as? ParagraphNode else {
        XCTFail("Couldn't find nodes")
        return
      }
      XCTAssertEqual(pNode.children.count, 2, "Expected two children on retrieved para node")

      // temp way to remove selection
      editor.getEditorState().selection = nil
      editor.testing_getPendingEditorState()?.selection = RangeSelection(
        anchor: Point(key: "2", offset: 0, type: .text),
        focus: Point(key: "2", offset: 0, type: .text),
        format: TextFormat())

      try pNode.getFirstChild()?.remove()
    }
    XCTAssertEqual("B", view.textStorage.string, "Should have deleted 'A'")

    // TODO: @alexmattice - Address rangeCache growth in follow-on diff
    // XCTAssertNil(editor.rangeCache["2"], "Should not have a node 2 any more!")
  }
  func testErrorRecovery() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail()
        return
      }
      let pNode = ParagraphNode()
      try rootNode.append([pNode])

      let tNode1 = TextNode(text: "A", key: nil)
      XCTAssertEqual(tNode1.key, "2", "Unexpected node key")
      try pNode.append([tNode1])

      let tNode2 = TextNode(text: "B", key: nil)
      try pNode.append([tNode2])
      XCTAssertEqual(pNode.children.count, 2, "Expected two children on newly created para node")
    }
    try editor.update {}

    do {
      try editor.update {
        guard let node = getNodeByKey(key: "2") as? TextNode else {
          XCTFail("Couldn't find node")
          return
        }
        try node.setText("C")
        throw LexicalError.internal("example-error")
      }
    } catch {
      XCTAssertEqual("AB", view.textStorage.string, "Text should be AB")
    }
  }

  func testParagraphStyleNormalisationWhenInserting() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      guard let root = getRoot(), let firstPara = root.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }
      let textNode = TextNode()
      try textNode.setText("Hello")
      try firstPara.append([textNode])

      let codeNode = CodeNode() // need something that will change the default paragraph style
      let textNode2 = TextNode()
      try textNode2.setText("world")
      try codeNode.append([textNode2])

      let textNode3 = TextNode()
      try textNode3.setText("again")
      let paragraph3 = ParagraphNode()
      try paragraph3.append([textNode3])

      try root.append([codeNode, paragraph3])
    }

    XCTAssertEqual(view.textView.text, "Hello\nworld\nagain")

    // get paragraph style at start of the last paragraph
    let paraStyle = view.textView.textStorage.attribute(.paragraphStyle, at: 12, effectiveRange: nil) as? NSParagraphStyle

    // insert a new character at end of the code node
    view.textView.selectedRange = NSRange(location: 11, length: 0)
    view.textView.insertText("x")

    // get paragraph style at start of the last paragraph again
    let paraStyle2 = view.textView.textStorage.attribute(.paragraphStyle, at: 13, effectiveRange: nil) as? NSParagraphStyle

    XCTAssertEqual(paraStyle, paraStyle2, "Expected two equal paragraph styles when editing previous Code node")
  }
}
