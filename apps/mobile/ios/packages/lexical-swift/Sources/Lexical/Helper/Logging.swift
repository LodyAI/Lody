/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

public extension CommandType {
  static let log = CommandType(rawValue: "log")
}

public enum LogFeature {
  case UITextView
  case NSTextStorage
  case node
  case editor
  case reconciler
  case TextView
  case other
}

public enum LogLevel: Int {
  case none = 0
  case error = 1
  case warning = 2
  case message = 3
  case verbose = 4
  case verboseIncludingUserContent = 5
}

public struct LogPayload {
  public let feature: LogFeature
  public let level: LogLevel
  public let string: String
  public let callingFunction: String
}

public extension Editor {
  func log(_ feature: LogFeature, _ level: LogLevel, _ string: String = "", _ callingFunction: String = #function) {
    let payload = LogPayload(feature: feature, level: level, string: string, callingFunction: callingFunction)
    self.dispatchCommand(type: .log, payload: payload)
  }
}
