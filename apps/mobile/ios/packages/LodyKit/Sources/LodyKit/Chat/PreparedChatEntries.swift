import Foundation

/// Navigation owns this decoded value; no process-wide history cache or cursor.
final class PreparedChatEntries {
  static let queue = DispatchQueue(label: "ai.lody.mobile.chat-prepare", qos: .userInitiated)
  let json: String
  let entries: [ChatEntry]

  init(_ json: String) throws {
    self.json = json
    entries = try Self.decode(json)
  }

  static func decode(_ json: String) throws -> [ChatEntry] {
    let entries = try JSONDecoder().decode([ChatEntry].self, from: Data(json.utf8))
    guard Set(entries.map(\.id)).count == entries.count,
          entries.allSatisfy({ Set($0.items.map(\.itemId)).count == $0.items.count }) else {
      throw NSError(domain: "LodyChat", code: 1)
    }
    return ChatEntry.showingCarriedPlans(entries)
  }
}
