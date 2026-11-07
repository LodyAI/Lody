/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

@objc public extension Editor {
  func registerCommandObjC(_ commandName: String, priority: CommandPriority, block: @escaping ((_ payload: Any?) -> Bool)) -> () -> Void {

    return self.registerCommand(
      type: CommandType(rawValue: commandName),
      listener: { payload in
        return block(payload)
      }, priority: priority)
  }

  @discardableResult
  func dispatchCommandObjC(_ commandName: String, payload: AnyObject? = nil) -> Bool {
    return dispatchCommand(type: CommandType(rawValue: commandName), payload: payload)
  }

  func getTextContentObjC() -> String {
    var text: String = ""
    try? self.read {
      text = getRoot()?.getTextContent() ?? ""
    }
    return text
  }
}
