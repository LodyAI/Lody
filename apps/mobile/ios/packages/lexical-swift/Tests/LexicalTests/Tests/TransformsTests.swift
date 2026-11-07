/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class TransformTests: XCTestCase {
  static let infiniteTransformKey = "I"
  static let combinedTransformKey = "G"
  static let terminalTransform = "Z"
  static let lastTransformKey = "F"
  static let neverTransformKey = "?" // This should never run and is only used for certain optionals
  static let simpleTransformKeys = ["A", "B", "C", "D", "E"]
  var transformCount: [String: Int] = [:]
  var updateLog: [String] = []

  var teardowns: [() -> Void] = []

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

    // To test the transform logic, we want to test the order of the logic of the transforms
    // A-E: Adds an entry to the log with the name "[A-F][Number of update]"
    // F: The last transform in the above grouping produces this text
    // G: Combines FG -> Z, ending a chain of transforms
    // I: Replaces I with itself, causing an infinite loop.

    let transforms = TransformTests.simpleTransformKeys

    for (index, key) in transforms.enumerated() {
      let nextKey = index < transforms.count - 1 ? transforms[index + 1] : TransformTests.lastTransformKey

      let teardown = editor.addNodeTransform(
        nodeType: NodeType.text,
        transform: { [weak self] node in
          guard let self else {
            XCTFail("strongSelf reference not found for text transform")
            return
          }

          guard let textNode = node as? TextNode else {
            throw LexicalError.invariantViolation("Text transform run on non-text node")
          }

          let textPart = textNode.getTextPart()

          guard textPart.contains(key) else {
            return
          }

          let count = (self.transformCount[key] ?? 0) + 1

          try textNode.setText(textPart.replacingOccurrences(of: key, with: nextKey))

          self.transformCount[key] = count
          self.updateLog.append("\(key)\(count)_start")
        })

      teardowns.append(teardown)
    }

    let infiniteTransform = editor.addNodeTransform(
      nodeType: NodeType.text,
      transform: { [weak self] node in
        guard let self else {
          XCTFail("strongSelf reference not found for text transform")
          return
        }

        guard let textNode = node as? TextNode else {
          throw LexicalError.invariantViolation("Text transform run on non-text node")
        }

        let textPart = textNode.getTextPart()

        guard textPart.contains(TransformTests.infiniteTransformKey) else {
          return
        }

        let count = (self.transformCount[TransformTests.infiniteTransformKey] ?? 0) + 1

        try textNode.setText(textPart)
        self.transformCount[TransformTests.infiniteTransformKey] = count
        self.updateLog.append("\(TransformTests.infiniteTransformKey)\(count)_start")
      })

    let combinedTransform = editor.addNodeTransform(
      nodeType: NodeType.text,
      transform: { [weak self] node in
        guard let self else {
          XCTFail("strongSelf reference not found for text transform")
          return
        }

        guard let textNode = node as? TextNode else {
          throw LexicalError.invariantViolation("Text transform run on non-text node")
        }

        let textPart = textNode.getTextPart()

        let combinedText = "\(TransformTests.lastTransformKey)\(TransformTests.combinedTransformKey)"

        guard textPart.contains(combinedText) else {
          return
        }

        let count = (self.transformCount[TransformTests.combinedTransformKey] ?? 0) + 1

        try textNode.setText(textPart.replacingOccurrences(of: combinedText, with: TransformTests.terminalTransform))

        self.transformCount[TransformTests.combinedTransformKey] = count
        self.updateLog.append("\(TransformTests.combinedTransformKey)\(count)_start")
      })

    teardowns.append(contentsOf: [infiniteTransform, combinedTransform])
  }

  override func tearDown() {
    for teardown in teardowns {
      teardown()
    }

    view = nil
  }

  // MARK: - Simple update tests

  func testNoUpdateOnCleanEditor() throws {
    try editor.update {}

    XCTAssert(updateLog.isEmpty, "Transforms were called when no updates occurred")
  }

  func testInfiniteTransformLoop() throws {
    try editor.update {
      guard let root = getActiveEditorState()?.getRootNode() else {
        XCTFail("Couldn't get root node")
        return
      }
      let paragraph = ParagraphNode()
      let text = TextNode(text: TransformTests.infiniteTransformKey)

      try root.append([paragraph])
      try paragraph.append([text])
    }

    XCTAssert(updateLog.count <= Editor.maxUpdateCount, "Did not prevent infinite update")
  }

  func testLinearlyDependentTransforms() throws {
    try editor.update {
      guard let root = getActiveEditorState()?.getRootNode() else {
        XCTFail("Couldn't get root node")
        return
      }
      let paragraph = ParagraphNode()
      let text = TextNode(text: TransformTests.simpleTransformKeys[0])

      try root.append([paragraph])
      try paragraph.append([text])
    }

    XCTAssert(updateLog.count == TransformTests.simpleTransformKeys.count, "Did not execute expected number of transforms")
  }

  func testSynchronouslyDependentTransforms() throws {
    try editor.update {
      guard let root = getActiveEditorState()?.getRootNode() else {
        XCTFail("Couldn't get root node")
        return
      }
      let paragraph = ParagraphNode()
      let text = TextNode(text: TransformTests.simpleTransformKeys[0])

      try root.append([paragraph])
      try paragraph.append([text])
    }

    XCTAssert(updateLog.count == TransformTests.simpleTransformKeys.count, "Did not execute expected number of transforms")

    for (index, transform) in TransformTests.simpleTransformKeys.enumerated() {
      XCTAssertTrue(updateLog[index].contains(transform), "Transforms were not executed in expected order")
    }
  }

  func testBranchingDependentTransforms() throws {
    try editor.update {
      guard let root = getActiveEditorState()?.getRootNode() else {
        XCTFail("Couldn't get root node")
        return
      }
      let paragraph = ParagraphNode()
      let text = TextNode(text: "\(TransformTests.simpleTransformKeys[0])\(TransformTests.combinedTransformKey)")

      try root.append([paragraph])
      try paragraph.append([text])
    }

    XCTAssert(updateLog.contains(where: { $0.contains(TransformTests.combinedTransformKey) }), "Did not execute dependent transform")
  }
}
