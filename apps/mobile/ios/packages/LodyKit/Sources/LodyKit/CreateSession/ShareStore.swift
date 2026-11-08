import LodyCore
import Foundation

struct ShareCatalog: Codable, Equatable {
  var userId: String
  var workspaceId: String
  var projects: [CreateProject]
  var machineNames: [String: String]?
}

struct ShareAttachment: Codable, Equatable {
  var id: String
  var name: String
  var uri: String
  var kind: String
}

// `draft` is nil when the extension had no cached options for the selection;
// the app then opens the creation form pre-filled instead of sending.
struct ShareManifest: Codable, Equatable {
  var id: String
  var createdAt: Double
  var userId: String
  var workspaceId: String
  var projectId: String?
  var context: String
  var text: String
  var attachments: [ShareAttachment]
  var draft: CreateSessionDraft?
}

// Never holds credentials or grants.
enum ShareStore {
  static let group = "group.ai.lody.mobile"
  static let limits = (total: 16, images: 8, files: 8, textBytes: 64 * 1024)
  // Set once by the native check before any access.
  nonisolated(unsafe) private static var override: URL?

  static var root: URL? {
    override ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
      .appendingPathComponent("Library/LodyShare\(BackendEnvironment.storageSuffix)", isDirectory: true)
  }

  static func useRoot(_ url: URL?) { override = url }

  private static func url(_ path: String) -> URL? { root?.appendingPathComponent(path) }

  static func isEntry(_ id: String) -> Bool { UUID(uuidString: id) != nil }

  private static func fileName(_ name: String) -> String {
    let last = (name as NSString).lastPathComponent
    return last.isEmpty || last == ".." ? "attachment" : last
  }

  private static func write(_ data: Data, to path: String) throws {
    guard let file = url(path) else { throw CocoaError(.fileNoSuchFile) }
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: file, options: .atomic)
  }

  private static func read<Value: Decodable>(_ type: Value.Type, _ path: String) -> Value? {
    guard let file = url(path), let data = try? Data(contentsOf: file) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }

  static func optionsPath(_ target: String) -> String {
    let safe = target.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "invalid"
    return "options/\(safe).json"
  }

  static func writeCatalog(_ json: String) throws {
    guard let catalog = CreateJSON.decode(ShareCatalog.self, json) else { throw CocoaError(.coderReadCorrupt) }
    if let previous = self.catalog(), previous.userId != catalog.userId || previous.workspaceId != catalog.workspaceId {
      for path in ["options", "branches", "prefs.json"] {
        if let stale = url(path) { try? FileManager.default.removeItem(at: stale) }
      }
    }
    try write(Data(CreateJSON.encode(catalog).utf8), to: "catalog.json")
  }

  static func writeOptions(_ options: CreationOptions, target: String) throws {
    try write(Data(CreateJSON.encode(options).utf8), to: optionsPath(target))
  }

  private static func branchesPath(_ repo: String) -> String {
    "branches/" + (repo.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "invalid") + ".json"
  }

  static func writeBranches(_ branches: CreateBranches, repo: String, userId: String, workspaceId: String) throws {
    guard let catalog = catalog(), catalog.userId == userId, catalog.workspaceId == workspaceId else { return }
    try write(Data(CreateJSON.encode(branches).utf8), to: branchesPath(repo))
  }

  static func branches(_ repo: String) -> CreateBranches? { read(CreateBranches.self, branchesPath(repo)) }

  static func writePrefs(_ prefs: CreatePrefs) throws {
    try write(Data(CreateJSON.encode(prefs).utf8), to: "prefs.json")
  }

  static func catalog() -> ShareCatalog? { read(ShareCatalog.self, "catalog.json") }
  static func prefs() -> CreatePrefs? { read(CreatePrefs.self, "prefs.json") }
  static func options(_ target: String) -> CreationOptions? { read(CreationOptions.self, optionsPath(target)) }

  static func clear() {
    guard let root else { return }
    try? FileManager.default.removeItem(at: root)
  }

  // The manifest is written last, so a partial inbox entry is never drained.
  static func enqueue(_ manifest: ShareManifest, files: [URL]) throws {
    guard isEntry(manifest.id), let entry = url("inbox/\(manifest.id)") else { throw CocoaError(.fileNoSuchFile) }
    let folder = entry.appendingPathComponent("files", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      var stored = manifest
      stored.attachments = try zip(manifest.attachments, files).map { attachment, source in
        let name = UUID().uuidString + "-" + fileName(attachment.name)
        try FileManager.default.copyItem(at: source, to: folder.appendingPathComponent(name))
        var copy = attachment
        copy.uri = name
        return copy
      }
      try write(Data(CreateJSON.encode(stored).utf8), to: "inbox/\(manifest.id)/manifest.json")
    } catch {
      try? FileManager.default.removeItem(at: entry)
      throw error
    }
  }

  static func pending() -> [ShareManifest] {
    guard let inbox = url("inbox"),
      let ids = try? FileManager.default.contentsOfDirectory(atPath: inbox.path) else { return [] }
    return ids.compactMap { read(ShareManifest.self, "inbox/\($0)/manifest.json") }.sorted { $0.createdAt < $1.createdAt }
  }

  // Copies attachments into this process's temporary directory, where uploads are allowed.
  static func adopt(_ id: String) throws -> ShareManifest {
    guard isEntry(id), var manifest = read(ShareManifest.self, "inbox/\(id)/manifest.json"),
      let folder = url("inbox/\(id)/files") else { throw CocoaError(.fileNoSuchFile) }
    manifest.attachments = try manifest.attachments.map { attachment in
      let destination = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString + "-" + fileName(attachment.name))
      try FileManager.default.copyItem(at: folder.appendingPathComponent(fileName(attachment.uri)), to: destination)
      var copy = attachment
      copy.uri = destination.absoluteString
      return copy
    }
    return manifest
  }

  static func remove(_ id: String) {
    guard isEntry(id), let entry = url("inbox/\(id)") else { return }
    try? FileManager.default.removeItem(at: entry)
  }
}
