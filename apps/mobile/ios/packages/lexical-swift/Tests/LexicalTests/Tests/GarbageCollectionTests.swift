/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class GarbageCollectionTests: XCTestCase {

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

  func testGarbageCollectDetachedNodes() throws {
    try editor.update {
      guard let editorState = getActiveEditorState(),
        let pendingEditorState = editor.testing_getPendingEditorState(),
        let rootNode = editorState.getRootNode()
      else {
        XCTFail("should have editor state")
        return
      }

      XCTAssertNotNil(editorState)
      XCTAssertEqual(editor.getEditorState().nodeMap.count, 2)

      let textNode = TextNode()
      try textNode.setText("A")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try rootNode.append([paragraphNode])
      let dirtyLeaves: DirtyNodeMap = [textNode.key: .userInitiated]

      XCTAssertEqual(editor.dirtyNodes.count, 4)

      try textNode.remove()

      XCTAssertEqual(pendingEditorState.nodeMap.count, 4)

      garbageCollectDetachedNodes(prevEditorState: editorState, editorState: editorState, dirtyLeaves: dirtyLeaves)
    }

    XCTAssertEqual(editor.getEditorState().nodeMap.count, 3)
  }

  func testGarbageCollectDetachedDeepChildNodes() throws {
    try editor.update {

      guard let editorState = getActiveEditorState(),
        let pendingEditorState = editor.testing_getPendingEditorState(),
        let rootNode = editorState.getRootNode()
      else {
        XCTFail("should have editor state")
        return
      }

      XCTAssertNotNil(editorState)

      let textNode = TextNode()
      try textNode.setText("A")
      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try rootNode.append([paragraphNode])

      XCTAssertNotNil(paragraphNode)
      XCTAssertEqual(paragraphNode.key, "2")
      XCTAssertEqual(textNode.getParent()?.key, "2")
      XCTAssertEqual(editorState.nodeMap.count, 4)
      XCTAssertEqual(editor.dirtyNodes.count, 4)

      guard let parentKey = textNode.getParent()?.key else {
        XCTFail("Failed to get parent key")
        return
      }

      try textNode.remove()

      XCTAssertEqual(pendingEditorState.nodeMap.count, 4)

      garbageCollectDetachedDeepChildNodes(
        node: paragraphNode,
        parentKey: parentKey,
        prevNodeMap: editor.getEditorState().nodeMap,
        nodeMap: editor.getEditorState().nodeMap,
        dirtyNodes: editor.dirtyNodes
      )
    }

    XCTAssertEqual(editor.getEditorState().nodeMap.count, 3)
  }
}
