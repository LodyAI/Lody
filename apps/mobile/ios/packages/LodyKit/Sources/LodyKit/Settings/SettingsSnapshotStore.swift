import Foundation

/// The last accepted list of a settings page, scoped to one account and workspace.
/// Pages show it at once and refresh behind it; a cached list never authorizes a write
/// (except Settings › GitHub, whose native writes re-read role and repositories and read back),
/// and logout's LocalStore generation fences a late write.
struct SettingsSnapshotStore<Value: Codable & Sendable>: Sendable {
  let key: String

  init(kind: String, userId: String, workspaceId: String) {
    key = "settings-snapshot:v1:\(kind):\(userId):\(workspaceId)"
  }

  var valid: Bool { !key.hasSuffix("::") && !key.contains("::") }

  func read() async -> Value? {
    guard valid else { return nil }
    let key = key
    let raw: String? = await withCheckedContinuation { done in
      LocalStore.queue.async { done.resume(returning: (try? LocalStore.shared.read(key)) ?? nil) }
    }
    guard let raw else { return nil }
    return try? JSONDecoder().decode(Value.self, from: Data(raw.utf8))
  }

  func write(_ value: Value) {
    guard valid, let data = try? JSONEncoder().encode(value) else { return }
    let key = key, raw = String(decoding: data, as: UTF8.self), generation = LocalStore.shared.generation
    LocalStore.queue.async { try? LocalStore.shared.write(key, raw, generation: generation) }
  }
}
