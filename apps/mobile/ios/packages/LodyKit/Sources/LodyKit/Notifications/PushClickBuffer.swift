import Foundation

/// One pending user intent survives bridge recreation, but never account replacement.
struct PushClickBuffer {
  private(set) var pending: [String: String]?

  mutating func receive(id: String, route: String, userId: String) {
    guard !id.isEmpty, !userId.isEmpty, route.hasPrefix("/"), route.utf8.count <= 2048 else { return }
    pending = ["id": id, "route": route, "userId": userId]
  }

  mutating func acknowledge(_ id: String) {
    if pending?["id"] == id { pending = nil }
  }

  mutating func identify(_ userId: String?) {
    if userId == nil || (pending != nil && pending?["userId"] != userId) { pending = nil }
  }

  static func isRegistered(_ id: String?) -> Bool {
    id.map { !$0.isEmpty && !$0.hasPrefix("local-") } ?? false
  }
}
