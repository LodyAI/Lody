/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import Lexical
import UIKit

public extension CommandType {
  static let undo = CommandType(rawValue: "undo")
  static let redo = CommandType(rawValue: "redo")
  static let canUndo = CommandType(rawValue: "canUndo")
  static let canRedo = CommandType(rawValue: "canRedo")
}
