import Foundation

// A display projection of the active session, never a second replica or subscription.
struct PermissionProjection: Equatable {
  enum State: Equatable {
    case waiting
    case ready(SessionPermission?)
    case invalid(String)
  }
  private(set) var state = State.waiting
  private var generation = -1
  private var revision = -1

  mutating func receive(generation incoming: Int, phase: String, json: String?) {
    guard incoming >= generation else { return }
    if incoming > generation {
      generation = incoming
      revision = -1
      state = .waiting
    }
    guard let json else {
      if ["starting", "background", "failed", "stopped"].contains(phase) { state = .waiting }
      return
    }
    do {
      guard let value = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
            value["v"] as? Int == 1, let next = value["revision"] as? Int,
            let status = value["status"] as? String, let entries = value["entries"] as? [[String: Any]] else {
        throw CocoaError(.coderReadCorrupt)
      }
      guard next > revision else { return }
      revision = next
      state = status == "live" ? .ready(try SessionPermission.first(in: entries)) : .waiting
    } catch { state = .invalid(error.localizedDescription) }
  }
}
