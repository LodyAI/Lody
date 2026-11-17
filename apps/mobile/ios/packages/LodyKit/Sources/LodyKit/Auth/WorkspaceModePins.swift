import Foundation

enum WorkspaceContentError: Error { case blocked }

enum WorkspaceContentMode: String, Codable, Sendable {
  case unknown, plaintext, e2ee
}

/// Encrypted identity is durable. Plaintext classification has an independent, optional cache.
final class WorkspaceModePins: @unchecked Sendable {
  static let shared = WorkspaceModePins(file: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("workspace-modes" + BackendEnvironment.storageSuffix + ".json"))
  typealias Writer = @Sendable (Data, URL) throws -> Void
  private static let lock = NSLock()
  private let file: URL
  private let write: Writer
  private var encrypted: Set<String> = []
  private var verifiedPlaintext: Set<String> = []
  private var unconfirmed: Set<String> = []
  init(file: URL, write: @escaping Writer = { data, url in
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
  }) { self.file = file; self.write = write }

  private var plaintextFile: URL { file.appendingPathExtension("plaintext") }
  private func load(_ url: URL) throws -> [String: String] {
    guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
    return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
  }
  private func current(_ id: String, retained: [String: String]) -> WorkspaceContentMode {
    if encrypted.contains(id) || retained[id].map({ $0 != "plaintext" }) == true { return .e2ee }
    if unconfirmed.contains(id) { return .unknown }
    if verifiedPlaintext.contains(id) || retained[id] == "plaintext" || (try? load(plaintextFile)[id]) == "plaintext" { return .plaintext }
    return .unknown
  }
  func mode(_ id: String) -> WorkspaceContentMode {
    Self.lock.withLock {
      if encrypted.contains(id) { return .e2ee }
      guard let retained = try? load(file) else { return .unknown }
      return current(id, retained: retained)
    }
  }
  func rejectPlaintext(_ id: String) { Self.lock.withLock { _ = unconfirmed.insert(id) } }
  func requirePlaintext(_ id: String) throws {
    guard mode(id) == .plaintext else { throw WorkspaceContentError.blocked }
  }

  @discardableResult
  func observe(_ id: String, mode: WorkspaceContentMode, genesis: String? = nil) throws -> WorkspaceContentMode {
    defer {
      if mode == .e2ee { NotificationCenter.default.post(name: .lodyWorkspaceEncryptionObserved, object: id) }
    }
    return try Self.lock.withLock {
      if mode == .e2ee { encrypted.insert(id); verifiedPlaintext.remove(id) }
      let retained = try load(file)
      if mode == .e2ee {
        var pins = retained.filter { $0.value != "plaintext" }
        if pins[id] == nil { pins[id] = "e2ee:" + (genesis ?? "") }
        try write(JSONEncoder().encode(pins), file)
        return .e2ee
      }
      if current(id, retained: retained) == .e2ee { return .e2ee }
      guard mode == .plaintext else { return current(id, retained: retained) }
      unconfirmed.remove(id)
      verifiedPlaintext.insert(id)
      var cache = (try? load(plaintextFile)) ?? [:]
      cache[id] = "plaintext"
      try? write(JSONEncoder().encode(cache), plaintextFile)
      return .plaintext
    }
  }
}

extension Notification.Name {
  static let lodyWorkspaceEncryptionObserved = Notification.Name("LodyWorkspaceEncryptionObserved")
}
