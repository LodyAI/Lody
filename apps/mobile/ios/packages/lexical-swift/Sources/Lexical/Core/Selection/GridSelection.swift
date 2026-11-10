/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

public final class GridSelection: BaseSelection {

  public func getTextContent() throws -> String {
    return ""
  }

  public func insertRawText(_ text: String) {
    // no-op
  }

  public func isSelection(_ selection: BaseSelection) -> Bool {
    return false // TODO
  }

  public var gridKey: NodeKey
  public var anchorCellKey: NodeKey
  public var focusCellKey: NodeKey
  public var dirty: Bool = false

  // MARK: - Init

  public init(gridKey: NodeKey, anchorCellKey: NodeKey, focusCellKey: NodeKey) {
    self.gridKey = gridKey
    self.anchorCellKey = anchorCellKey
    self.focusCellKey = focusCellKey
  }

  public func clone() -> BaseSelection {
    return GridSelection(gridKey: gridKey, anchorCellKey: anchorCellKey, focusCellKey: focusCellKey)
  }

  public func getNodes() throws -> [Node] {
    return []
  }

  public func extract() throws -> [Node] {
    return []
  }

  public func insertNodes(nodes: [Node], selectStart: Bool = false) throws -> Bool {
    // TODO
    return false
  }

  public func deleteCharacter(isBackwards: Bool) throws {
    // TODO
  }

  public func deleteWord(isBackwards: Bool) throws {
    // TODO
  }

  public func deleteLine(isBackwards: Bool) throws {
    // TODO
  }

  public func insertParagraph() throws {
    // TODO
  }

  public func insertLineBreak(selectStart: Bool) throws {
    // TODO
  }

  public func insertText(_ text: String) throws {
    // TODO
  }
}

extension GridSelection: CustomDebugStringConvertible {
  public var debugDescription: String {
    return "Grid Selection"
  }
}
