/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

/**
 This protocol represents things common to all types of selection.
 */
public protocol BaseSelection: AnyObject, CustomDebugStringConvertible {
  /// True if the selection has had any changes made that need reconciling.
  var dirty: Bool { get set }

  /// Makes an identical copy of this selection.
  func clone() -> BaseSelection

  /// Extracts the nodes in the Selection, splitting nodes if necessary to get offset-level precision.
  func extract() throws -> [Node]

  /// Returns all the nodes in or partially in the Selection. This function is designed to be more performant than ``extract()``.
  func getNodes() throws -> [Node]

  /// Returns a plain text representation of the content of the selection.
  func getTextContent() throws -> String

  /// Attempts to insert the provided text into the EditorState at the current Selection, converting tabs, newlines, and carriage returns into LexicalNodes.
  func insertRawText(_ text: String) throws

  /// Checks for selection equality.
  func isSelection(_ selection: BaseSelection) -> Bool

  // MARK: - Handling incoming events

  /**
   * Attempts to "intelligently" insert an arbitrary list of Lexical nodes into the EditorState at the
   * current Selection according to a set of heuristics that determine how surrounding nodes
   * should be changed, replaced, or moved to accommodate the incoming ones.
   *
   * - Parameter nodes: the nodes to insert
   * - Parameter selectStart: whether or not to select the start after the insertion.
   * - Returns: true if the nodes were inserted successfully, false otherwise.
   */
  func insertNodes(nodes: [Node], selectStart: Bool) throws -> Bool

  /// Does the equivalent of pressing the backspace key.
  func deleteCharacter(isBackwards: Bool) throws

  /// Handles a delete word event, e.g. option-backspace on Apple platforms
  func deleteWord(isBackwards: Bool) throws

  /// Handles a delete line event, e.g. command-backspace on Apple platforms
  func deleteLine(isBackwards: Bool) throws

  /// Handles the user pressing carriage-return
  func insertParagraph() throws

  /// Handles inserting a soft line break (which does not split paragraphs)
  func insertLineBreak(selectStart: Bool) throws

  /// Handles user-provided text to insert, applying a series of insertion heuristics based on the selection type and position.
  func insertText(_ text: String) throws
}
