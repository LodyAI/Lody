import Foundation

/// One pending user intent survives bridge recreation, but never account replacement.
struct PushClickBuffer {
  private(set) var pending: [String: String]?
  private var acknowledged: String?

  mutating func receive(id: String, route: String, userId: String) {
    guard id != acknowledged, !id.isEmpty, !userId.isEmpty, route.hasPrefix("/"), route.utf8.count <= 2048 else { return }
    pending = ["id": id, "route": route, "userId": userId]
  }

  mutating func acknowledge(_ id: String) {
    if pending?["id"] == id { pending = nil; acknowledged = id }
  }

  mutating func identify(_ userId: String?) {
    if userId == nil || (pending != nil && pending?["userId"] != userId) { pending = nil }
  }

  static func payload(_ info: [AnyHashable: Any]) -> (route: String, recipient: String)? {
    // OneSignal may not have initialized yet when a cold scene receives a click.
    let custom = info["custom"] as? [String: Any]
    let data = custom?["a"] as? [String: Any] ?? info as? [String: Any] ?? [:]
    guard let route = data["route"] as? String, let recipient = data["recipientUserId"] as? String,
          !recipient.isEmpty, route.hasPrefix("/"), route.utf8.count <= 2048 else { return nil }
    return (route, recipient)
  }

  static func shouldDisplay(userId: String?, recipient: String?, route: String?, visibleRoute: String) -> Bool {
    guard let userId, !userId.isEmpty, recipient == userId else { return false }
    return visibleRoute.isEmpty || route != visibleRoute
  }

  static func isRegistered(_ id: String?) -> Bool {
    id.map { !$0.isEmpty && !$0.hasPrefix("local-") } ?? false
  }
}
