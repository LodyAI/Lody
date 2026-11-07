/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class NodeTests: XCTestCase {
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

  func testCreateNodesIncrementKey() throws {
    try editor.update {
      let node = Node()
      let node2 = Node()
      let node3 = Node(LexicalConstants.uninitializedNodeKey)
      XCTAssertNotNil(node)
      XCTAssertNotNil(node2)
      XCTAssertEqual(node.key, "1")
      XCTAssertEqual(node2.key, "2")
      XCTAssertEqual(node3.key, "3")
    }
  }

  func testReadNodeMap() throws {
    var node: Node?
    var paragraphNode: ParagraphNode?
    var rootNode: RootNode?

    try editor.update {
      node = Node()
      paragraphNode = ParagraphNode()

      guard let node, let paragraphNode else {
        XCTFail("can't get node")
        return
      }

      rootNode = editor.getEditorState().getRootNode()
      try paragraphNode.append([node])
      try rootNode?.append([paragraphNode])
      XCTAssertNotNil(node)
    }

    try editor.getEditorState().read {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }
      XCTAssertTrue(editorState.nodeMap["1"] === node)
    }
  }

  func testRootNodeGetsAutoCreated() throws {
    try editor.getEditorState().read {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }
      XCTAssertNotNil(editorState.getRootNode())
    }
  }

  func testRootNodeClone() throws {
    try editor.getEditorState().read {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }
      let rootNode = editorState.getRootNode()

      XCTAssert(rootNode?.key == "root", "The key for rootNode should be root.")
      XCTAssert(rootNode?.type == NodeType.root, "RootNode type should be root")
      if let clonedRoot = rootNode?.clone() as? RootNode {
        XCTAssert(clonedRoot.key == "root", "The clone of RootNode should have key as root")
      }
    }
  }

  func testTextNodeClone() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("Hello")

      let clonedText = textNode.clone()

      XCTAssertTrue(textNode.type == NodeType.text, "TextNode type property should be text")
      XCTAssertTrue(textNode.key == clonedText.key, "Cloned object should have same key as TextNode")
      XCTAssertTrue(clonedText.type == NodeType.text, "Cloned object's type should also be text")
    }
  }

  func testParagraphNodeClone() throws {
    try editor.update {
      let paragraphNode = ParagraphNode()
      let clonedParagraph = paragraphNode.clone()

      XCTAssertTrue(paragraphNode.type == NodeType.paragraph, "ParagraphNode type property should be paragraph")
      XCTAssertTrue(paragraphNode.key == clonedParagraph.key, "Cloned object should have same key as ParagraphNode")
      XCTAssertTrue(clonedParagraph.type == NodeType.paragraph, "Cloned object's type should also be paragraph")
    }
  }

  func testTextNode() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello world")
      XCTAssertEqual(textNode.getTextPart(), "hello world")
    }
  }

  func testTextNodeFormatSerialization() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello world")
      var textFormat = TextFormat()
      textFormat.bold = true
      textFormat.underline = true
      textNode.format = textFormat

      let encoder = JSONEncoder()
      let data = try encoder.encode(textNode)
      guard let jsonString = String(data: data, encoding: .utf8) else { return }
      print(jsonString)
      XCTAssertTrue(jsonString.contains("\"format\":9"))
    }
  }

  func testTextNodeFormatDeserialization() throws {
    let jsonString = "{\"format\":9,\"detail\":0,\"style\":\"\",\"mode\":\"normal\",\"text\":\"hello world\",\"version\":1,\"type\":\"text\"}"

    let decoder = JSONDecoder()
    let decodedNode = try decoder.decode(TextNode.self, from: (jsonString.data(using: .utf8) ?? Data()))
    XCTAssertTrue(decodedNode.format.bold)
    XCTAssertTrue(decodedNode.format.underline)
    XCTAssertFalse(decodedNode.format.strikethrough)
    XCTAssertFalse(decodedNode.format.code)
    XCTAssertFalse(decodedNode.format.superScript)
    XCTAssertFalse(decodedNode.format.subScript)
  }

  func testParagraphNode() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let textNode3 = TextNode()
      try textNode3.setText("hello again")

      guard let paragraphNode = getActiveEditorState()?.getRootNode()?.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let paragraphNode2 = ParagraphNode()
      try paragraphNode2.append([textNode3])

      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail("should have editor state")
        return
      }
      try rootNode.append([paragraphNode2])
    }

    XCTAssertEqual(editor.textStorage?.string, "hello world\nhello again")
  }

  func testCodeHighlightNode() throws {
    try editor.update {
      let codeNode = CodeHighlightNode()
      try codeNode.setText("Test code node")
      XCTAssertEqual(codeNode.getTextPart(), "Test code node")
      XCTAssertEqual(codeNode.type, NodeType.codeHighlight)
    }
  }

  func testIndexWithinParent() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let textNode3 = TextNode()
      try textNode3.setText("hello again")

      guard let paragraphNode = getActiveEditorState()?.getRootNode()?.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let paragraphNode2 = ParagraphNode()
      try paragraphNode2.append([textNode3])

      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail("should have editor state")
        return
      }
      try rootNode.append([paragraphNode2])

      XCTAssertEqual(textNode.getIndexWithinParent(), 0)
      XCTAssertEqual(textNode2.getIndexWithinParent(), 1)
      XCTAssertEqual(textNode3.getIndexWithinParent(), 0)

      XCTAssertEqual(paragraphNode.getIndexWithinParent(), 0)
      XCTAssertEqual(paragraphNode2.getIndexWithinParent(), 1)
    }
  }

  func testIsRootNode() throws {
    var textNodeKey: NodeKey?
    var root: RootNode?

    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")
      textNodeKey = textNode.key

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      guard let rootNode = editor.getEditorState().getRootNode() else {
        XCTFail("can't get root node")
        return
      }

      root = rootNode

      try root?.append([paragraphNode])
    }

    try editor.getEditorState().read {
      guard let textNodeKey else {
        XCTFail("should have editor state")
        return
      }

      guard let textNode = getNodeByKey(key: textNodeKey) else {
        XCTFail("Expected text node to be retrieved")
        return
      }

      XCTAssert(isRootNode(node: root))
      XCTAssert(root?.key == "root", "The key for rootNode should be root.")
      XCTAssert(root?.type == NodeType.root, "RootNode type should be root")
      XCTAssert(!isRootNode(node: textNode))
      XCTAssert(textNode.key != "root", "The key for textNode should not be root.")
      XCTAssert(textNode.type != NodeType.root, "TextNode type should not be root")
    }
  }

  func testGetChildAtIndex() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      XCTAssert(paragraphNode.getChildAtIndex(index: 1)?.key == textNode2.key)
      XCTAssert(paragraphNode.getChildAtIndex(index: 2)?.key == nil)
    }
  }

  func testGetParent() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      XCTAssert(paragraphNode === textNode.getParent())
      XCTAssert(paragraphNode === textNode2.getParent())
      XCTAssert(textNode !== textNode2.getParent())
    }
  }

  func testGetTopLevelElement() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode?.append([paragraphNode])

      XCTAssert(textNode.getTopLevelElement() === paragraphNode)
      XCTAssert(textNode2.getTopLevelElement() === paragraphNode)
      XCTAssert(textNode.getTopLevelElement() !== rootNode)
      XCTAssert(textNode2.getTopLevelElement() !== rootNode)
    }
  }

  func testGetParents() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail("should have editor state")
        return
      }
      try rootNode.append([paragraphNode])

      XCTAssertEqual(textNode.getParents().count, 2)
      XCTAssertEqual(paragraphNode.getParents().count, 1)
      XCTAssertTrue(isRootNode(node: textNode.getParents()[1]))
      XCTAssertTrue(isRootNode(node: paragraphNode.getParents()[0]))
    }
  }

  func testGetParentKeys() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")

      guard let editorState = getActiveEditorState(), let rootNode: RootNode = try editorState.getRootNode()?.getWritable() else {
        XCTFail("should have editor state")
        return
      }
      guard let paragraphNode = rootNode.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }
      try paragraphNode.append([textNode])

      let textParentKeys = textNode.getParentKeys()
      let paragraphParentKeys = paragraphNode.getParentKeys()

      XCTAssertEqual(textParentKeys.count, 2)
      XCTAssertTrue(textParentKeys[1] == "root")
      XCTAssertTrue(textParentKeys[0] == "0")
      XCTAssertEqual(paragraphParentKeys.count, 1)
      XCTAssertTrue(paragraphParentKeys[0] == "root")
    }
  }

  func testGetCommonAncestor() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      guard let rootNode = editorState.getRootNode() else {
        XCTFail("Should have root node")
        return
      }

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let paragraphNode2 = ParagraphNode()

      try rootNode.append([paragraphNode])
      try rootNode.append([paragraphNode2])

      XCTAssertEqual(textNode.getCommonAncestor(node: textNode2), paragraphNode, "text node common ancestor with textnode2 should be paragraph node")
      XCTAssertEqual(paragraphNode.getCommonAncestor(node: paragraphNode2), rootNode.getLatest(), "paragraphNode node common ancestor with paranode2 should be root node")
      XCTAssertNotEqual(textNode2.getCommonAncestor(node: paragraphNode), rootNode.getLatest(), "textNode2 node common ancestor with paranode should not be root node")
    }
  }

  func testGetPreviousSibling() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }
      let rootNode = editorState.getRootNode()

      try rootNode?.append([paragraphNode])

      XCTAssert(textNode2.getPreviousSibling() === textNode)
      XCTAssert(textNode.getPreviousSibling() == nil)
    }
  }

  func testGetNextSibling() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }
      let rootNode = editorState.getRootNode()

      try rootNode?.append([paragraphNode])

      XCTAssert(textNode.getNextSibling() === textNode2)
      XCTAssert(textNode2.getNextSibling() == nil)
    }
  }

  func testGetPreviousSiblings() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode?.append([paragraphNode])
      let previousSibling = textNode2.getPreviousSiblings()

      XCTAssert(previousSibling.first === textNode)
      XCTAssert(previousSibling.count == 1)
    }
  }

  func testGetFirstChild() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let node = ElementNode()
      try node.append([textNode])

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let node1 = ElementNode()
      try node1.append([textNode2])

      try rootNode?.append([node])
      try rootNode?.append([node1])

      XCTAssertEqual(node.getFirstChild(), textNode)
      XCTAssertNotEqual(node.getFirstChild(), textNode2)
    }
  }

  func testGetLastChild() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let node = ElementNode()
      try node.append([textNode])

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let node1 = ElementNode()
      try node1.append([textNode2])

      try rootNode?.append([node])
      try rootNode?.append([node1])

      XCTAssertEqual(node.getLastChild(), textNode)
      XCTAssertNotEqual(node.getLastChild(), textNode2)
    }
  }

  func testGetNextSiblings() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode, textNode2])

      try rootNode?.append([paragraphNode])
      let nextSibling = textNode.getNextSiblings()

      XCTAssert(nextSibling.first === textNode2)
      XCTAssert(nextSibling.count == 1)

      let shouldBeEmptyArray = textNode2.getNextSiblings()
      XCTAssertEqual(shouldBeEmptyArray.count, 0)
    }
  }

  func testGetTopLevelElementOrThrow() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      guard let topLevelElement = try? textNode.getTopLevelElementOrThrow() as? ParagraphNode else {
        XCTFail("should have top level element node")
        return
      }

      XCTAssert(topLevelElement === paragraphNode)
    }
  }

  func testIsParentOf() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertTrue(paragraphNode.isParentOf(textNode))

      if let rootNode {
        XCTAssertTrue(rootNode.isParentOf(paragraphNode))
      }
    }
  }

  func testGetChildIndex() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode?.append([paragraphNode])

      XCTAssertEqual(textNode.getChildIndex(commonAncestor: paragraphNode, node: textNode2), 1)
      XCTAssertEqual(textNode2.getChildIndex(commonAncestor: paragraphNode, node: textNode), 0)
    }
  }

  func testIsBefore() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode?.append([paragraphNode])

      XCTAssertTrue(textNode.isBefore(textNode2))
      XCTAssertTrue(textNode.isBefore(paragraphNode))
      XCTAssertFalse(textNode2.isBefore(textNode))

      if let rootNode {
        XCTAssertTrue(paragraphNode.isBefore(rootNode))
        XCTAssertFalse(rootNode.isBefore(textNode))
      }
    }
  }

  func testGetKey() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode?.append([paragraphNode])

      XCTAssertNotNil(textNode.getKey())
      XCTAssertNotNil(textNode2.getKey())
      XCTAssertNotNil(paragraphNode.getKey())

      if let rootNode {
        XCTAssertNotNil(rootNode.getKey())
      }
    }
  }

  func testIsSameKey() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let paragraphNode2 = ParagraphNode()
      paragraphNode2.key = paragraphNode.key

      try rootNode?.append([paragraphNode])

      XCTAssertFalse(textNode.isSameKey(textNode2))
      XCTAssertFalse(paragraphNode.isSameKey(textNode))
      XCTAssertFalse(paragraphNode.isSameKey(textNode2))
      XCTAssertTrue(paragraphNode.isSameKey(paragraphNode2))
      XCTAssertTrue(paragraphNode.isSameKey(paragraphNode))
      XCTAssertTrue(textNode2.isSameKey(textNode2))
    }
  }

  func testGetNodesBetween() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let textNode3 = TextNode()
      try textNode3.setText("test")

      let textNode4 = TextNode()
      try textNode4.setText("text node 4")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])
      try paragraphNode.append([textNode3])

      let paragraphNode2 = ParagraphNode()
      try paragraphNode2.append([textNode4])

      try rootNode?.append([paragraphNode])
      try rootNode?.append([paragraphNode2])

      XCTAssertEqual(textNode.getNodesBetween(targetNode: textNode), [textNode])
      XCTAssertEqual(textNode.getNodesBetween(targetNode: textNode2), [textNode, textNode2])
      XCTAssertEqual(
        textNode.getNodesBetween(
          targetNode: textNode3),
        [textNode, textNode2, textNode3]
      )

      XCTAssertEqual(
        textNode.getNodesBetween(
          targetNode: textNode4),
        [textNode, textNode2, textNode3, paragraphNode.getLatest(), paragraphNode2, textNode4]
      )

      XCTAssertNotEqual(textNode.getNodesBetween(targetNode: textNode4), [textNode2])
    }
  }

  func testIsAttached() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      XCTAssertFalse(paragraphNode.isAttached())
      XCTAssertFalse(textNode.isAttached())

      try rootNode?.append([paragraphNode])

      XCTAssertTrue(paragraphNode.isAttached())
      XCTAssertTrue(textNode.isAttached())
    }
  }

  func testElementNodeHasNewlineAtEndOnlyWhenNotInline() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      guard let paragraphNode = getActiveEditorState()?.getRootNode()?.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])
    }

    XCTAssertEqual(editor.textStorage?.string, "hello world", "Making sure string has no paragraph break")

    try editor.update {
      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        XCTFail("should have editor state")
        return
      }

      let textNode = TextNode()
      try textNode.setText("next ")

      let textNode2 = TextNode()
      try textNode2.setText("para")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode.append([paragraphNode])
    }

    XCTAssertEqual(editor.textStorage?.string, "hello world\nnext para", "Making sure string has paragraph break between paras but not at end")
  }

  func testGetChildrenSize() throws {
    try editor.update {
      createExampleNodeTree()

      guard let rootNode = getActiveEditorState()?.getRootNode() else {
        XCTFail("No root node")
        return
      }

      let children = rootNode.getChildren()
      let firstChild = getNodeByKey(key: children[0].key) as? ElementNode

      XCTAssertEqual(rootNode.getChildrenSize(), children.count)
      XCTAssertEqual(firstChild?.getChildrenSize(), 2)

      let textNode2 = TextNode()
      try textNode2.setText("world")

      try firstChild?.append([textNode2])
      XCTAssertEqual(firstChild?.getChildrenSize(), 3)

      let paragraphNode = ParagraphNode()
      try rootNode.append([paragraphNode])
      XCTAssertEqual(paragraphNode.getChildrenSize(), 0)
    }
  }

  func testGetChildren() throws {
    try editor.update {
      createExampleNodeTree()

      guard let rootNode = getActiveEditorState()?.getRootNode() else {
        XCTFail("No root node")
        return
      }

      let children = rootNode.getChildren()

      XCTAssertEqual(children.count, 4, "Expected 4 children")
      XCTAssertEqual(children.map { $0.key }, ["0", "4", "5", "7"], "Expected children with keys 0,4,5,7")
    }
  }

  func testGetDescendantByIndex() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode?.append([paragraphNode])

      XCTAssert(paragraphNode.getDescendantByIndex(index: 0) === textNode)
      XCTAssert(paragraphNode.getDescendantByIndex(index: 1) === textNode2)
      XCTAssertFalse(paragraphNode.getDescendantByIndex(index: 0) === textNode2)
    }
  }

  func testGetFirstDescendant() throws {
    try editor.update {
      createExampleNodeTree()

      guard let rootNode = getActiveEditorState()?.getRootNode() else {
        XCTFail("No root node")
        return
      }

      let children = rootNode.getChildren()

      XCTAssert(rootNode.getFirstDescendant() == (getNodeByKey(key: children[0].key) as? ElementNode)?.getFirstChild())
      XCTAssert(rootNode.getFirstDescendant() != (getNodeByKey(key: children[children.count - 1].key) as? ElementNode)?.getFirstChild())
    }
  }

  func testGetLastDescendant() throws {
    try editor.update {
      createExampleNodeTree()

      guard let rootNode = getActiveEditorState()?.getRootNode() else {
        XCTFail("No root node")
        return
      }

      let children = rootNode.getChildren()

      XCTAssert(rootNode.getLastDescendant() == (getNodeByKey(key: children[children.count - 1].key) as? ElementNode)?.getLastChild())
      XCTAssert(rootNode.getLastDescendant() != (getNodeByKey(key: children[0].key) as? ElementNode)?.getLastChild())
    }
  }

  func testGetAllTextNodes() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode.setText("world")

      let textNode3 = TextNode()
      try textNode.setText("and another one")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])
      try paragraphNode.append([textNode3])

      try rootNode?.append([paragraphNode])

      XCTAssertEqual(paragraphNode.getAllTextNodes(includeInert: false).count, 3)

      let textNode4 = TextNode()
      try textNode4.setText("another text node")
      textNode.mode = .inert

      try paragraphNode.append([textNode4])

      let elementNode = ElementNode()
      try paragraphNode.append([elementNode])

      XCTAssertEqual(paragraphNode.getAllTextNodes(includeInert: false).count, 3)
      XCTAssertEqual(paragraphNode.getAllTextNodes(includeInert: true).count, 4)
      XCTAssertEqual(
        paragraphNode.getAllTextNodes(
          includeInert: true
        ),
        [textNode, textNode2, textNode3, textNode4]
      )
    }
  }

  func testIsTextNode() throws {
    try editor.update {
      let node = ElementNode()
      let textNode = TextNode()
      try textNode.setText("hello")

      XCTAssertFalse(isTextNode(node))
      XCTAssertTrue(isTextNode(textNode))
    }
  }

  func testIsInert() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")
      textNode.mode = .normal

      XCTAssertFalse(textNode.isInert())

      textNode.mode = .inert

      XCTAssertTrue(textNode.isInert())
    }
  }

  func testIsToken() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")
      textNode.mode = .normal

      XCTAssertFalse(textNode.isToken())

      textNode.mode = .token

      XCTAssertTrue(textNode.isToken())
    }
  }

  func testIsTokenOrInert() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")
      textNode.mode = .normal

      XCTAssertFalse(isTokenOrInert(textNode))

      textNode.mode = .token

      XCTAssertTrue(isTokenOrInert(textNode))

      textNode.mode = .inert

      XCTAssertTrue(isTokenOrInert(textNode))
    }
  }

  func testGetCompositionKey() throws {
    editor.compositionKey = NodeKey("0")

    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertNotNil(getCompositionKey())
      XCTAssertEqual(getCompositionKey(), "0")
    }
  }

  func testIsComposing() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      editor.compositionKey = textNode.getKey()

      XCTAssertTrue(textNode.isComposing(), "Text node is not composing")

      editor.compositionKey = NodeKey("other")

      XCTAssertFalse(textNode.isComposing(), "Text node is composing")
    }
  }

  func testGetParentOrThrow() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertEqual(try textNode.getParentOrThrow(), paragraphNode)
      XCTAssertNotEqual(try textNode.getParentOrThrow(), rootNode)

      let textNode2 = TextNode()
      try textNode2.setText("world")

      XCTAssertThrowsError(try textNode2.getParentOrThrow())
    }
  }

  func testSpliceText() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello")

      let textNode2 = TextNode()
      try textNode2.setText("pizza")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertEqual(
        try textNode.spliceText(
          offset: 0,
          delCount: 0,
          newText: "test ",
          moveSelection: false
        ).getTextPart(),
        "test hello"
      )

      XCTAssertEqual(
        try textNode2.spliceText(
          offset: 2,
          delCount: -2,
          newText: "ece of ",
          moveSelection: false
        ).getTextPart(),
        "piece of pizza"
      )
    }
  }

  func testSpliceTextWithMultiCodePointUtf16Character() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("😀")

      let textNode2 = TextNode()
      try textNode2.setText("😇")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertEqual(
        try textNode.spliceText(
          offset: 0,
          delCount: 0,
          newText: textNode2.getTextPart(),
          moveSelection: true
        ).getTextPart(),
        "😇😀"
      )
    }
  }

  func testCreateTextNode() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode, textNode2])

      try rootNode?.append([paragraphNode])

      XCTAssertNotNil(createTextNode(text: "hi"))
      XCTAssertEqual(createTextNode(text: "hello ").getTextPart(), textNode.getTextPart())
      XCTAssertNotNil(createTextNode(text: nil))
      XCTAssertEqual(createTextNode(text: nil).getTextPart(), textNode2.getTextPart())
    }
  }

  func testShouldInsertTextAfterOrBeforeTextNode() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode2.key, offset: 4, type: .text)
      let anotherPoint = createPoint(key: paragraphNode.key, offset: 2, type: .element)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      let selection2 = RangeSelection(anchor: anotherPoint, focus: anotherPoint, format: TextFormat())

      XCTAssertTrue(shouldInsertTextAfterOrBeforeTextNode(selection: selection, node: textNode))
      XCTAssertFalse(shouldInsertTextAfterOrBeforeTextNode(selection: selection2, node: textNode2))
    }
  }

  func testCheckIfTokenOrCanTextBeInserted() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertFalse(checkIfTokenOrCanTextBeInserted(node: textNode))
      XCTAssertFalse(checkIfTokenOrCanTextBeInserted(node: textNode2))

      let textNode3 = TextNode()
      try textNode3.setText("again")
      textNode3.mode = .token

      XCTAssertTrue(checkIfTokenOrCanTextBeInserted(node: textNode3))
    }
  }

  func testGetFormat() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")
      textNode.format = TextFormat()

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertEqual(textNode.getFormat(), TextFormat())
    }
  }

  func testSetFormat() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")
      textNode.format = TextFormat()

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertNotNil(try textNode.setFormat(format: TextFormat()))
      XCTAssertEqual(try textNode.setFormat(format: TextFormat()), textNode)
    }
  }

  func testSetFormatAttributeCheck() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      var format = TextFormat()
      format.bold = true

      let textNode = TextNode()
      try textNode.setText("hello ")

      var textNode2 = TextNode()
      try textNode.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode, textNode2])

      try rootNode?.append([paragraphNode])

      textNode2 = try textNode.setFormat(format: format)

      XCTAssertEqual(textNode2.getAttributedStringAttributes(theme: editor.getTheme()).count, 1)
      XCTAssertTrue(textNode2.getAttributedStringAttributes(theme: editor.getTheme()).contains { $0.key == .bold })
      XCTAssertFalse(textNode2.getAttributedStringAttributes(theme: editor.getTheme()).contains { $0.key == .italic })
    }
  }

  func testRemove() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode?.append([paragraphNode])

      try textNode.remove()
      XCTAssert(textNode.getParent() == nil)
      XCTAssert(paragraphNode.getParent() != nil)
      XCTAssert(editor.dirtyNodes[textNode.key] != nil)

      try paragraphNode.remove()
      XCTAssert(paragraphNode.getParent() == nil)

      try rootNode?.remove()
      XCTAssert(rootNode?.getParent() == nil)
    }
  }

  func testSplitText() throws {
    try editor.update {

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let splitNode = try textNode.splitText(splitOffsets: [4])
      XCTAssert(splitNode[0].getTextPart() == "hell")

      let splitNode1 = try textNode2.splitText(splitOffsets: [2])
      XCTAssert(splitNode1[0].getTextPart() == "wo")
    }
  }

  func testInsertAfter() throws {
    try editor.update {
      createExampleNodeTree()

      let nodeToInsert = TextNode()
      try nodeToInsert.setText("Fourth Para.")

      if let textNode = getNodeByKey(key: "6") {
        let insertedNode = try textNode.insertAfter(nodeToInsert: nodeToInsert)
        XCTAssertEqual(nodeToInsert, insertedNode)
        XCTAssertEqual(insertedNode.parent, "7")
        let testNode = textNode.getNextSibling()

        XCTAssertEqual(testNode, insertedNode)
      }
    }
  }

  func testAppendExistingNodeToNewParent() throws {
    try editor.update {
      createExampleNodeTree()

      if let textNode = getNodeByKey(key: "6"),
        let newParentNode = getNodeByKey(key: "2") as? ElementNode,
        let oldParent = getNodeByKey(key: "7") as? ElementNode
      {
        XCTAssertEqual(textNode.parent, "7")

        try newParentNode.append([textNode])

        XCTAssertEqual(textNode.parent, "2")
        XCTAssertEqual(newParentNode.getChildrenSize(), 3)
        XCTAssertEqual(oldParent.getChildrenSize(), 0)
      }
    }
  }

  func testIsEmpty() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let paragraphNode = ParagraphNode()

      XCTAssertTrue(paragraphNode.isEmpty())

      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      XCTAssertFalse(paragraphNode.isEmpty())
    }
  }

  func testReplace() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      let textNode3 = TextNode()
      try textNode3.setText("again")
      try textNode3.setBold(true)

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode, textNode2])

      try rootNode?.append([paragraphNode])

      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
      let endPoint = createPoint(key: textNode2.key, offset: 4, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      editorState.selection = selection

      XCTAssertThrowsError(try textNode3.replace(replaceWith: textNode))
      XCTAssertEqual(try textNode2.replace(replaceWith: textNode), textNode)
      XCTAssertEqual(try textNode.replace(replaceWith: textNode3), textNode3)
    }
  }

  func testReplaceParagraphNode() throws {
    // creating tree
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()
      let paragraphNode = ParagraphNode() // key 1
      let anotherParagraphNode = ParagraphNode() // key 2
      let key = anotherParagraphNode.key

      try rootNode?.append([paragraphNode, anotherParagraphNode])
      let selection = RangeSelection(
        anchor: Point(key: key, offset: 0, type: .element),
        focus: Point(key: key, offset: 0, type: .element),
        format: TextFormat())
      editorState.selection = selection
    }

    // replacing paragraphNode with new headingNode
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      if let rootNode = editorState.getRootNode() {
        XCTAssertTrue(rootNode.children.contains("2"))
      }

      let newHeadingNode = createHeadingNode(headingTag: .h1) // key 3
      guard let selection = editorState.selection as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }
      let anchorNode = try selection.anchor.getNode()
      if let paragraph = anchorNode as? ElementNode {
        try paragraph.replace(replaceWith: newHeadingNode)
      }
    }

    // verify
    try editor.read {
      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        XCTFail("should have editor state")
        return
      }

      XCTAssertEqual(rootNode.children.count, 3)
      XCTAssertEqual(rootNode.children[0], "0")
      XCTAssertEqual(rootNode.children[1], "1")
      XCTAssertEqual(rootNode.children[2], "3")
      XCTAssertFalse(rootNode.children.contains("2"))

      if let headingNode = getNodeByKey(key: "3") as? HeadingNode {
        XCTAssertEqual(headingNode.parent, kRootNodeKey)
      }
    }
  }

  func testUpdateHeadingStyle() throws {
    var key: NodeKey = "1"

    // creating tree
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()
      let paragraphNode = ParagraphNode() // key 0
      let textNode = TextNode() // key 1
      try textNode.setText("Text Node")
      let anotherParagraphNode = ParagraphNode() // key 2
      try paragraphNode.append([textNode])
      key = textNode.key

      try rootNode?.append([paragraphNode, anotherParagraphNode])
      let selection = RangeSelection(
        anchor: Point(key: key, offset: 0, type: .text),
        focus: Point(key: key, offset: 8, type: .text),
        format: TextFormat())
      editorState.selection = selection
    }

    // replacing paragraphNode with new headingNode
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      if let rootNode = editorState.getRootNode() {
        XCTAssertFalse(rootNode.children.contains("2"))
      }
    }

    try editor.update {
      guard let selection = try getSelection() as? RangeSelection else {
        XCTFail("Expected range selection")
        return
      }
      setBlocksType(selection: selection) {
        createHeadingNode(headingTag: .h1)
      }
    }

    // verify
    try editor.read {
      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        XCTFail("should have editor state")
        return
      }

      XCTAssertEqual(rootNode.children.count, 3)
      XCTAssertEqual(rootNode.children[0], "0")
      XCTAssertEqual(rootNode.children[1], "4")
      XCTAssertEqual(rootNode.children[2], "3")
      XCTAssertFalse(rootNode.children.contains("1"))

      if let headingNode = getNodeByKey(key: "4") as? HeadingNode {
        XCTAssertEqual(headingNode.parent, kRootNodeKey)
      }
    }

    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let selection = RangeSelection(
        anchor: Point(key: key, offset: 0, type: .text),
        focus: Point(key: key, offset: 4, type: .text),
        format: TextFormat())
      editorState.selection = selection

      setBlocksType(selection: selection) {
        createHeadingNode(headingTag: .h1)
      }
    }

    try editor.read {
      guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
        XCTFail("should have editor state")
        return
      }

      XCTAssertEqual(rootNode.children.count, 3)
      XCTAssertEqual(rootNode.children[0], "0")
      XCTAssertEqual(rootNode.children[1], "5")
      XCTAssertEqual(rootNode.children[2], "3")
      XCTAssertFalse(rootNode.children.contains("4"))

      if let headingNode = getNodeByKey(key: "5") as? HeadingNode {
        print("replaced heading node!")
        XCTAssertEqual(headingNode.parent, kRootNodeKey)
      }
    }
  }

  func testIsSimpleText() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("hello ")
      textNode2.mode = .inert

      XCTAssertTrue(textNode.isSimpleText())
      XCTAssertFalse(textNode2.isSimpleText())
    }
  }

  func testSelectPrevious() throws {
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

      let selection = try textNode2.selectPrevious(anchorOffset: 0, focusOffset: 0)
      XCTAssert(selection.anchor.offset == 0)
      XCTAssert(selection.focus.offset == 0)

      let selection1 = try textNode.selectPrevious(anchorOffset: 0, focusOffset: 0)
      XCTAssert(selection1.anchor.offset == 0)

      let selection2 = try paragraphNode.selectPrevious(anchorOffset: 0, focusOffset: 0)
      XCTAssert(selection2.anchor.offset == 0)
    }
  }

  func testInsertBeforeNodeToInsert() throws {
    editor.compositionKey = NodeKey("0")

    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("text node 2")

      let textNode3 = TextNode()
      try textNode3.setText("world")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      try rootNode?.append([paragraphNode])

      XCTAssertEqual(try textNode.insertBefore(nodeToInsert: textNode2), textNode2)
      XCTAssertNotEqual(try textNode.insertBefore(nodeToInsert: textNode2), textNode)
      XCTAssertThrowsError(try textNode3.insertBefore(nodeToInsert: textNode))
      XCTAssertThrowsError(try textNode.insertBefore(nodeToInsert: textNode3))
    }
  }

  func testCreateParagraphNode() throws {
    XCTAssertTrue(isElementNode(node: createParagraphNode()))
    XCTAssertNotNil(createParagraphNode())

    editor.compositionKey = NodeKey("0")

    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let paragraphNode = createParagraphNode()

      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertTrue(paragraphNode.getChildren().contains(textNode))
    }
  }

  func testInsertBefore() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      guard let rootNode = editorState.getRootNode() else { return }

      XCTAssertThrowsError(try rootNode.insertBefore(nodeToInsert: rootNode))
    }
  }

  func testRemoveRoot() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      guard let rootNode = editorState.getRootNode() else { return }

      XCTAssertThrowsError(try rootNode.remove())
    }
  }

  func testReplaceRoot() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      guard let rootNode = editorState.getRootNode() else { return }

      XCTAssertThrowsError(try rootNode.replace(replaceWith: rootNode))
    }
  }

  func testInsertAfterRoot() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      guard let rootNode = editorState.getRootNode() else { return }

      XCTAssertThrowsError(try rootNode.insertAfter(nodeToInsert: rootNode))
    }
  }

  func testToggleTextFormatType() throws {
    let formatInitial = TextFormat()

    var format = toggleTextFormatType(format: formatInitial, type: .bold, alignWithFormat: nil)
    XCTAssertNotEqual(formatInitial, format)
    XCTAssertTrue(format.bold)
    XCTAssertFalse(format.italic)

    format = toggleTextFormatType(format: format, type: .italic, alignWithFormat: nil)
    XCTAssertNotEqual(format, formatInitial)
    XCTAssertTrue(format.bold)
    XCTAssertTrue(format.italic)

    format = toggleTextFormatType(format: format, type: .italic, alignWithFormat: nil)
    XCTAssertFalse(format.italic)
    XCTAssertTrue(format.bold)
    XCTAssertNotEqual(format, formatInitial)
  }

  func testGetFormatFlags() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello ")

      let paragraphNode = createParagraphNode()

      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      var format = textNode.getFormatFlags(type: .bold)
      XCTAssertTrue(format.bold)
      XCTAssertFalse(format.italic)

      format = textNode.getFormatFlags(type: .italic)
      XCTAssertTrue(format.italic)
    }
  }

  func testMergeWithSibling() throws {
    try editor.update {

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world ")

      let textNode3 = TextNode()
      try textNode3.setText("welcome")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])
      try paragraphNode.append([textNode3])

      let rootNode = editor.getEditorState().getRootNode()
      try rootNode?.append([paragraphNode])

      let selection = try textNode2.select(anchorOffset: 3, focusOffset: 3)
      let mergedSibling = try textNode2.mergeWithSibling(target: textNode)
      XCTAssert(mergedSibling.getTextPart() == "hello world ")
      XCTAssert(mergedSibling.key == textNode2.key)
      XCTAssertEqual(selection.anchor.offset, 9)
      XCTAssertEqual(selection.focus.offset, 9)

      let selection1 = try textNode3.select(anchorOffset: 0, focusOffset: 0)
      let mergedSibling1 = try textNode3.mergeWithSibling(target: textNode2)
      XCTAssert(mergedSibling1.getTextPart() == "hello world welcome")
      XCTAssert(mergedSibling1.key == textNode3.key)
      XCTAssertEqual(selection1.anchor.offset, 12)
      XCTAssertEqual(selection1.focus.offset, 12)
    }
  }

  func testSelectNext() throws {
    try editor.update {

      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world")

      guard let paragraphNode = getActiveEditorState()?.getRootNode()?.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      let selection = try textNode2.selectNext(anchorOffset: 0, focusOffset: 0)
      XCTAssert(selection.anchor.offset == 2)
      XCTAssert(selection.focus.offset == 2)

      let selection1 = try textNode.selectNext(anchorOffset: 0, focusOffset: 0)
      XCTAssert(selection1.anchor.offset == 0)

      let selection2 = try paragraphNode.selectNext(anchorOffset: 0, focusOffset: 0)
      XCTAssert(selection2.anchor.offset == 1)
    }
  }

  func testGetTextContent() throws {
    try editor.update {
      guard let editorState = getActiveEditorState() else {
        XCTFail("should have editor state")
        return
      }

      let rootNode = editorState.getRootNode()

      let textNode = TextNode()
      try textNode.setText("hello")

      let paragraphNode = createParagraphNode()

      try paragraphNode.append([textNode])

      try rootNode?.append([paragraphNode])

      XCTAssertEqual(textNode.getTextContent(), "hello")

      textNode.mode = .inert
      XCTAssertEqual(textNode.getTextContent(), "")

      textNode.mode = .normal
      textNode.detail.isDirectionless = true
      XCTAssertEqual(textNode.getTextContent(), "")
    }
  }

  func testIsDirectionless() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")
      textNode.detail.isDirectionless = false

      XCTAssertFalse(textNode.isDirectionless())

      textNode.detail.isDirectionless = true

      XCTAssertTrue(textNode.isDirectionless())
    }
  }

  func testGetNodeHierarchy() throws {
    try editor.update {
      guard let rootNode = getActiveEditorState()?.getRootNode() else {
        XCTFail("No root node")
        return
      }

      let paragraphNode = ParagraphNode()

      let textNode = TextNode()
      try textNode.setText("Hello")

      try paragraphNode.append([textNode])
      try rootNode.append([paragraphNode])
    }

    let hierarchyString = try getNodeHierarchy(editorState: editor.getEditorState())
    XCTAssertNotNil(hierarchyString)
  }

  func testIsUnmergeable() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello")
      textNode.detail.isUnmergable = false

      XCTAssertFalse(textNode.isUnmergeable())

      textNode.detail.isUnmergable = true

      XCTAssertTrue(textNode.isUnmergeable())
    }
  }

  func testCanSimpleTextBeMerged() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world ")
      textNode2.mode = .inert

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      _ = TextNode.canSimpleTextNodesBeMerged(node1: textNode, node2: textNode2)

      XCTAssertFalse(textNode.mode == textNode2.mode)
      XCTAssertEqual(textNode.format, textNode2.format)
    }
  }

  func testMergeTextNode() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world ")
      textNode2.mode = .inert

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])

      _ = try TextNode.mergeTextNodes(node1: textNode, node2: textNode2)
      XCTAssert(textNode.getTextPart() == "hello world ")
    }
  }

  func testNormalizeTextNode() throws {
    try editor.update {
      let textNode = TextNode()
      try textNode.setText("hello ")

      let textNode2 = TextNode()
      try textNode2.setText("world ")

      let textNode3 = TextNode()
      try textNode3.setText("")

      let paragraphNode = ParagraphNode()
      try paragraphNode.append([textNode])
      try paragraphNode.append([textNode2])
      try paragraphNode.append([textNode3])

      try TextNode.normalizeTextNode(textNode: textNode3)
      XCTAssertEqual(textNode3.getTextContent(), "")
      XCTAssertTrue(textNode3.isSimpleText())
      XCTAssert(textNode3.getParent() == nil)

      try TextNode.normalizeTextNode(textNode: textNode2)
      XCTAssert(textNode.getTextPart() == "hello world ")
    }
  }

  //  func testInternalCreateNodeFromParse() throws {
  //    guard let editor = editor else {
  //      XCTFail("Editor unexpectedly nil")
  //      return
  //    }
  //
  //    try editor.update {
  //      guard let pendingEditorState = editor.testing_getPendingEditorState() else {
  //        XCTFail("Could not get pendingEditorState")
  //        return
  //      }
  //
  //      let node = ParagraphNode()
  //
  //      let createdNode = try internalCreateNodeFromParse(
  //        parsedNode: node,
  //        parsedNodeMap: pendingEditorState.nodeMap,
  //        editor: editor,
  //        parentKey: node.getParent()?.key,
  //        state: nil
  //      )
  //
  //      XCTAssertNotNil(createdNode)
  //
  //      if let castNode = createdNode as? ParagraphNode {
  //        XCTAssertEqual(node.children.count, castNode.children.count, "Empty node children did not match")
  //      } else {
  //        XCTFail("Parsed node was not a paragraph node")
  //      }
  //
  //      let textNode = TextNode()
  //      let paragraphNode = ParagraphNode()
  //      try textNode.setText("hello")
  //      try paragraphNode.append([textNode])
  //
  //      let createdTextNode = try internalCreateNodeFromParse(
  //        parsedNode: textNode,
  //        parsedNodeMap: pendingEditorState.nodeMap,
  //        editor: editor,
  //        parentKey: textNode.getParent()?.key,
  //        state: nil
  //      )
  //
  //      XCTAssertNotNil(createdTextNode)
  //      XCTAssertEqual(textNode.getTextContent(), createdTextNode.getTextContent(), "Parsed text did not match")
  //
  //      let createdParagraphNode = try internalCreateNodeFromParse(
  //        parsedNode: paragraphNode,
  //        parsedNodeMap: pendingEditorState.nodeMap,
  //        editor: editor,
  //        parentKey: paragraphNode.getParent()?.key,
  //        state: nil
  //      )
  //
  //      XCTAssertNotNil(createdParagraphNode)
  //      if let castParagraphNode = createdParagraphNode as? ParagraphNode {
  //        XCTAssertEqual(paragraphNode.children.count, castParagraphNode.children.count, "Paragraph node with children did not have the same number of children")
  //      } else {
  //        XCTFail("Parsed node wasn't a paragraph node")
  //      }
  //
  //      let startPoint = createPoint(key: textNode.key, offset: 0, type: .text)
  //      let endPoint = createPoint(key: textNode.key, offset: 4, type: .text)
  //      let rangeSelection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
  //      var parserState = NodeParserState()
  //      parserState.originalSelection = rangeSelection
  //      parserState.remappedSelection = rangeSelection
  //
  //      let nodeWithRangeSelection = try internalCreateNodeFromParse(
  //        parsedNode: textNode,
  //        parsedNodeMap: pendingEditorState.nodeMap,
  //        editor: editor,
  //        parentKey: textNode.getParent()?.key,
  //        state: parserState
  //      )
  //
  //      XCTAssertNotNil(nodeWithRangeSelection)
  //      XCTAssertEqual(textNode.getTextContent(), nodeWithRangeSelection.getTextContent())
  //    }
  //  }

  func testNoCrashWhenSplittingMultiCodepointString() throws {
    let unicodeTestString = "Test\u{1f609}"

    guard let view else {
      XCTFail("Editor unexpectedly nil")
      return
    }

    try editor.update {
      let textNode = TextNode()
      try textNode.setText(unicodeTestString)

      guard let paragraphNode = getActiveEditorState()?.getRootNode()?.getFirstChild() as? ParagraphNode else {
        XCTFail()
        return
      }
      try paragraphNode.append([textNode])

      let startPoint = createPoint(key: textNode.key, offset: 1, type: .text)
      let endPoint = createPoint(key: textNode.key, offset: 1, type: .text)
      let selection = RangeSelection(anchor: startPoint, focus: endPoint, format: TextFormat())
      try selection.insertParagraph()
    }

    XCTAssertEqual(view.textStorage.string, "T\nest\u{1f609}")
  }
}
