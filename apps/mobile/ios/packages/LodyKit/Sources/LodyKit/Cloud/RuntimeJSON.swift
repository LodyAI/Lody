import Foundation

enum RuntimeJSON {
  struct Invalid: Error {}

  static func object(_ value: some Encodable) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] else { throw Invalid() }
    return object
  }

  // Wrapping in an array admits fragments (strings, null, booleans) and lets the
  // validity check run first; JSONSerialization raises an ObjC exception instead of throwing.
  static func decode<T: Decodable>(_ type: T.Type, from value: Any) throws -> T {
    guard JSONSerialization.isValidJSONObject([value]) else { throw Invalid() }
    let data = try JSONSerialization.data(withJSONObject: [value])
    guard let decoded = try JSONDecoder().decode([T].self, from: data).first else { throw Invalid() }
    return decoded
  }
}
