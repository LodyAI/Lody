import Foundation

struct PreferencesSnapshot: Codable, Equatable, Sendable {
  let accentColor: String
  let queuedMessageBehavior: String
}

enum LodyPreferences {
  private static let queuedKey = "queuedMessageBehavior"
  private static let developerKey = "developerModeEnabled"
  private static let roostKey = "roostHistoryExperimentEnabled"

  static var developerModeEnabled: Bool { UserDefaults.standard.bool(forKey: developerKey) }
  static var roostHistoryEnabled: Bool { developerModeEnabled && UserDefaults.standard.bool(forKey: roostKey) }
  static var roostHistoryExperimentEnabled: Bool { UserDefaults.standard.bool(forKey: roostKey) }

  static func saveDeveloperMode(_ enabled: Bool) {
    UserDefaults.standard.set(enabled, forKey: developerKey); changed()
  }
  static func saveRoostHistoryExperiment(_ enabled: Bool) {
    UserDefaults.standard.set(enabled, forKey: roostKey); changed()
  }

  static var snapshot: PreferencesSnapshot {
    PreferencesSnapshot(
      accentColor: "ink",
      queuedMessageBehavior: queuedMessageBehavior
    )
  }

  static var json: String {
    (try? JSONEncoder().encode(snapshot)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }

  static var queuedMessageBehavior: String {
    UserDefaults.standard.string(forKey: queuedKey) == "guide" ? "guide" : "queue"
  }

  static func saveQueuedMessageBehavior(_ value: String) {
    let next = value == "guide" ? "guide" : "queue"
    guard next != queuedMessageBehavior else { return }
    UserDefaults.standard.set(next, forKey: queuedKey)
    changed()
  }

  private static func changed() {
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: .lodyPreferencesDidChange, object: nil)
    }
  }
}

extension Notification.Name {
  static let lodyPreferencesDidChange = Notification.Name("LodyPreferencesDidChange")
}
