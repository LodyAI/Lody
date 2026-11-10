/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class UpdatesTests: XCTestCase {

  func testUpdateNodeMap() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor
    var node: Node?

    try editor.update {
      let editorState = getActiveEditorState()
      XCTAssertNotNil(editorState)
      node = Node()

      guard let node else {
        XCTFail("should have node")
        return
      }

      guard let paragraphNode = getRoot()?.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }

      try paragraphNode.append([node])
    }

    XCTAssertNotNil(node)
    try editor.getEditorState().read {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }
      XCTAssertTrue(editorState.nodeMap["1"] === node)
    }
  }

  func testEditorStateNotNil() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.getEditorState().read {
      let editorState = getActiveEditorState()
      XCTAssertNotNil(editorState)
    }
  }

  func testUpdateListenersIsFired() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    var listenerCount = 0
    var updateCount = 0

    _ = editor.registerUpdateListener(listener: { editorState, previousEditorState, dirtyNodes in
      listenerCount += 1
    })

    XCTAssertTrue(listenerCount == 0)
    XCTAssertTrue(updateCount == 0)

    try editor.update {
      updateCount += 1
    }
    try editor.update {
      updateCount += 1
    }

    XCTAssertTrue(listenerCount == 2)
    XCTAssertTrue(updateCount == 2)
  }

  func testUpdateListenersCanBeUnsubscribed() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    var listenerCount = 0
    var updateCount = 0

    let unsubscribe = editor.registerUpdateListener(listener: { editorState, previousEditorState, dirtyNodes in
      listenerCount += 1
    })

    try editor.update {
      updateCount += 1
    }
    try editor.update {
      updateCount += 1
    }

    XCTAssertTrue(listenerCount == 2)
    XCTAssertTrue(updateCount == 2)

    unsubscribe()

    try editor.update {
      updateCount += 1
    }
    try editor.update {
      updateCount += 1
    }

    XCTAssertTrue(listenerCount == 2)
    XCTAssertTrue(updateCount == 4)
  }

  func testTextContentListenersOnlyFireOnTextContentChanges() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    var updateListenerCount = 0
    var textContentListenerCount = 0
    var updateCount = 0

    _ = editor.registerUpdateListener(listener: { editorState, previousEditorState, dirtyNodes in
      updateListenerCount += 1
    })
    _ = editor.registerTextContentListener(listener: { latestTextContent in
      textContentListenerCount += 1
    })

    XCTAssertTrue(updateListenerCount == 0)
    XCTAssertTrue(textContentListenerCount == 0)
    XCTAssertTrue(updateCount == 0)

    try editor.update {
      updateCount += 1
    }
    try editor.update {
      updateCount += 1
    }

    XCTAssertTrue(updateListenerCount == 2)
    XCTAssertTrue(textContentListenerCount == 0)
    XCTAssertTrue(updateCount == 2)

    try editor.update {
      guard let rootNode = getActiveEditorState()?.getRootNode(), let paragraphNode = rootNode.getFirstChild() as? ParagraphNode else {
        XCTFail("No root node")
        return
      }

      updateCount += 1

      let textNode = TextNode()
      try textNode.setText("Hello world 2")
      try paragraphNode.append([textNode])
    }

    XCTAssertTrue(updateListenerCount == 3)
    XCTAssertTrue(textContentListenerCount == 1)
    XCTAssertTrue(updateCount == 3)
  }

  func testCommandListenersFireWhenDispatchCommandIsCalled() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    let validCommandType = CommandType.click
    let invalidCommandtype = CommandType.deleteLine

    var dispatchCount = 0
    var validCommandTypeCount = 0

    _ = editor.registerCommand(
      type: validCommandType,
      listener: { payload in
        validCommandTypeCount += 1

        return true
      })

    editor.dispatchCommand(type: invalidCommandtype, payload: nil)
    editor.dispatchCommand(type: validCommandType, payload: nil)
    editor.dispatchCommand(type: invalidCommandtype, payload: nil)

    dispatchCount += 3

    XCTAssertTrue(dispatchCount == 3)
    XCTAssertTrue(validCommandTypeCount == 1)
  }

  func testCommandListenersFiredInPriorityOrder() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    let editor = view.editor

    try editor.update {
      createExampleNodeTree()
    }

    var commandListenerCount = 0

    _ = editor.registerCommand(
      type: CommandType.click,
      listener: { payload in
        commandListenerCount += 1

        XCTAssertEqual(commandListenerCount, 2)

        return true
      },
      priority: CommandPriority.Editor
    )
    _ = editor.registerCommand(
      type: CommandType.click,
      listener: { payload in
        commandListenerCount += 1

        XCTAssertEqual(commandListenerCount, 1)

        return true
      },
      priority: CommandPriority.High
    )

    editor.dispatchCommand(type: CommandType.click, payload: nil)
  }
}
