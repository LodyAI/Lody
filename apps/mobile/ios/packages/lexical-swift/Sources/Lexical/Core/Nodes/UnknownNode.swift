/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

// NB: This class is meant to represent unknown nodes serialized *with JSON*. This is a very
//     important distinction as the class has no means of representing mappings with keys as
//     arbitrary values (ex: say { null: new Uint8Array() } were encoded with a protobuf)
//     which is possible with the generic Codable interface.
public class UnknownNode: Node {
  struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init?(stringValue: String) {
      self.stringValue = stringValue
    }

    init?(intValue: Int) {
      return nil
    }
  }

  enum SupportedValue: Codable, Equatable {
    case null
    case int(Int64)
    case double(Double)
    case bool(Bool)
    case string(String)
    case object([String: SupportedValue])
    case array([SupportedValue])

    func encode(to encoder: Encoder) throws {
      // Unfortunately in Swift there is no way to "defer" serialization. Since this is intended to
      // be used with JSON primitives we support what JSON supports out of the box.
      var container = encoder.singleValueContainer()

      switch self {
      case .null:
        try container.encodeNil()
      case .bool(let value):
        try container.encode(value)
      case .int(let value):
        try container.encode(value)
      case .double(let value):
        try container.encode(value)
      case .string(let value):
        try container.encode(value)
      case .object(let values):
        try container.encode(values)
      case .array(let values):
        try container.encode(values)
      }
    }

    init(from decoder: Decoder) throws {
      if let container = try? decoder.container(keyedBy: AnyCodingKey.self) {
        var values = [String: SupportedValue]()

        for codingKey in container.allKeys {
          // According to the JSON spec, any valid key must be a double-quoted string. Therefore,
          // we assume keys are strings.
          values[codingKey.stringValue] = try SupportedValue(from: container.superDecoder(forKey: codingKey))
        }

        self = .object(values)
      } else if var container = try? decoder.unkeyedContainer() {
        var values = [SupportedValue]()

        if let count = container.count {
          values.reserveCapacity(count)
        }

        while !container.isAtEnd {
          values.append(try container.decode(SupportedValue.self))
        }

        self = .array(values)
      } else if let container = try? decoder.singleValueContainer() {
        if let value = try? container.decode(Bool.self) {
          self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
          self = .int(value)
        } else if let value = try? container.decode(Double.self) {
          self = .double(value)
        } else if let value = try? container.decode(String.self) {
          self = .string(value)
        } else if container.decodeNil() {
          self = .null
        } else {
          throw LexicalError.invariantViolation("Unsupported value present in decoded node map")
        }
      } else {
        throw LexicalError.invariantViolation("Unsupported value present in decoded node map")
      }
    }
  }

  private(set) var data: SupportedValue = .null

  override var parent: NodeKey? {
    didSet {
      if case var .object(values) = data {
        if let value = parent {
          values["parent"] = .string(value)
        } else {
          values.removeValue(forKey: "parent")
        }
      }
    }
  }

  init(data: SupportedValue) {
    self.data = data
    super.init()
  }

  public required init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()

    data = try container.decode(SupportedValue.self)

    // NB: As consuming keys in a coding container is a stateful operation, certain keys are
    //     re-extracted and initialized similarly to the super class here.
    super.init()
  }

  override open func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()

    try container.encode(data)
  }

  override public func getTextPart() -> String {
    "□"
  }
}
