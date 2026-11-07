import Foundation
import LodyCore

typealias OutboxValue = RuntimeContract.JSONValue

extension RuntimeContract.JSONValue {
  var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  var object: [String: OutboxValue]? {
    if case .object(let value) = self { return value }
    return nil
  }

  var truthy: Bool {
    switch self {
    case .null: return false
    case .bool(let value): return value
    case .number(let value): return value != 0 && !value.isNaN
    case .string(let value): return !value.isEmpty
    case .array, .object: return true
    }
  }
}

struct OutboxRecord: Codable, Sendable, Equatable {
  var session: [String: OutboxValue]
  var send: [String: OutboxValue]

  var sessionId: String { session["id"]?.string ?? "" }
  var sendId: String { send["id"]?.string ?? "" }
  var phase: String { send["phase"]?.string ?? "" }
  var creation: String? { send["creation"]?.truthy == true ? send["creation"]?.string : nil }

  func with(phase: String, reason: String? = nil, dropCreation: Bool = false) -> OutboxRecord {
    var next = self
    next.send["phase"] = .string(phase)
    if let reason { next.send["reason"] = .string(reason) }
    if dropCreation { next.send["creation"] = nil }
    return next
  }

  static func restore(_ raw: String?, awaitingConfirmation: String) -> [OutboxRecord] {
    guard let raw, let saved = try? JSONDecoder().decode(OutboxValue.self, from: Data(raw.utf8)),
          case .array(let items) = saved else { return [] }
    return items.compactMap { item in
      guard let session = item.object?["session"]?.object, session["id"]?.truthy == true,
            let send = item.object?["send"]?.object, send["id"]?.truthy == true,
            send["text"]?.string != nil, case .array? = send["attachments"],
            send["choice"]?.truthy == true else { return nil }
      let record = OutboxRecord(session: session, send: send)
      guard record.phase == "creating" || record.phase == "sending" else { return record }
      return record.with(phase: "unknown", reason: awaitingConfirmation)
    }
  }

  static func encode(_ records: [OutboxRecord]) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    return (try? encoder.encode(records)).map { String(decoding: $0, as: UTF8.self) } ?? "[]"
  }

  static func decode(_ json: String) -> OutboxRecord? {
    try? JSONDecoder().decode(OutboxRecord.self, from: Data(json.utf8))
  }
}
