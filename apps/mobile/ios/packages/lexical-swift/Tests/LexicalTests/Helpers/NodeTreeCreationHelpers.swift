/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Disabled during swift-format 6.3 rollout, feel free to remove:
// swift-format-ignore-file: OrderedImports

import Foundation
import XCTest

@testable import Lexical

// swiftlint:disable force_try

/* Produces text output:
 *
 * hello world\n
 * Paragraph 2 contains another text node\n
 * \n
 * Third para.
 */
func createExampleNodeTree() {
  guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
    XCTFail("should have editor state")
    return
  }

  guard let paragraphNode = rootNode.getFirstChild() as? ParagraphNode else { // key 0
    XCTFail("Didn't find pre-prepared paragraph node")
    return
  }

  let textNode = TextNode() // key 1
  try! textNode.setText("hello ")

  let textNode2 = TextNode() // key 2
  try! textNode2.setBold(true)
  try! textNode2.setText("world")

  try! paragraphNode.append([textNode])
  try! paragraphNode.append([textNode2])

  let textNode3 = TextNode() // key 3
  try! textNode3.setText("Paragraph 2 contains another text node")
  let paragraphNode2 = ParagraphNode() // key 4
  try! paragraphNode2.append([textNode3])

  let emptyPara = ParagraphNode() // key 5

  let textNode4 = TextNode() // key 6
  try! textNode4.setText("Third para.")
  let paragraphNode3 = ParagraphNode() // key 7
  try! paragraphNode3.append([textNode4])

  try! rootNode.append([paragraphNode2])
  try! rootNode.append([emptyPara])
  try! rootNode.append([paragraphNode3])
}

// swiftlint:enable force_try
