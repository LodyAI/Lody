import Foundation

public enum RuntimeContract {
  public struct Key: CodingKey, Sendable, Hashable {
    public let stringValue: String
    public var intValue: Int? { nil }
    public init(_ stringValue: String) { self.stringValue = stringValue }
    public init?(stringValue: String) { self.stringValue = stringValue }
    public init?(intValue: Int) { nil }
  }

  public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
      let c = try decoder.singleValueContainer()
      if c.decodeNil() { self = .null }
      else if let value = try? c.decode(Bool.self) { self = .bool(value) }
      else if let value = try? c.decode(Double.self) { self = .number(value) }
      else if let value = try? c.decode(String.self) { self = .string(value) }
      else if let value = try? c.decode([JSONValue].self) { self = .array(value) }
      else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.singleValueContainer()
      switch self {
      case .null: try c.encodeNil()
      case .bool(let value): try c.encode(value)
      case .number(let value): try c.encode(value)
      case .string(let value): try c.encode(value)
      case .array(let value): try c.encode(value)
      case .object(let value): try c.encode(value)
      }
    }
  }

  public struct Header: Decodable, Sendable {
    public let v: Int
    public let gen: Int
    public let kind: String
    public let method: String?
    public let id: String?
  }
}

public protocol RuntimeCall {
  associatedtype Params: Encodable & Sendable
  associatedtype Result: Sendable
  static var method: String { get }
  static var timeout: Double { get }
  static func result(_ value: RuntimeContract.CallResult) -> Result?
}

public protocol RuntimeHostCall {
  associatedtype Params: Sendable
  associatedtype Result: Encodable & Sendable
  static var method: String { get }
  static var timeout: Double { get }
}
