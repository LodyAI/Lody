import Foundation
import SQLite3

/// Access only on queue. Display projections, never credentials or CRDT state.
final class LocalStore: @unchecked Sendable {
  static let queue = DispatchQueue(label: "ai.lody.mobile.local-store", qos: .userInitiated)
  static let shared = LocalStore()
  private var db: OpaquePointer?
  private let url: URL
  private let generationLock = NSLock()
  private var currentGeneration = 0

  var generation: Int { generationLock.withLock { currentGeneration } }

  init(url: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Lody/catalog.sqlite")) {
    self.url = url
  }
  deinit { sqlite3_close(db) }

  private func open() throws {
    if db != nil { return }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    do {
      guard sqlite3_open(url.path, &db) == SQLITE_OK else { throw failure() }
      try execute("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
      try execute("CREATE TABLE IF NOT EXISTS session_prose (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL, item_id TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (user_id, workspace_id, session_id, entry_id, item_id))")
    } catch {
      sqlite3_close(db); db = nil
      throw error
    }
  }
  private func failure() -> NSError {
    NSError(domain: "Lody.LocalStore", code: Int(sqlite3_errcode(db)))
  }
  private func execute(_ sql: String, _ values: [String] = []) throws {
    let statement = try prepare(sql, values)
    defer { sqlite3_finalize(statement) }
    guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() }
  }
  private func prepare(_ sql: String, _ values: [String]) throws -> OpaquePointer {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw failure() }
    for (index, value) in values.enumerated() {
      sqlite3_bind_text(statement, Int32(index + 1), value, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    }
    return statement
  }
  func read(_ key: String) throws -> String? {
    try open()
    let statement = try prepare("SELECT value FROM cache WHERE key = ?", [key])
    defer { sqlite3_finalize(statement) }
    let result = sqlite3_step(statement)
    if result == SQLITE_DONE { return nil }
    guard result == SQLITE_ROW, let value = sqlite3_column_text(statement, 0) else { throw failure() }
    return String(cString: value)
  }
  func write(_ key: String, _ value: String) throws {
    // ponytail: one complete projection per workspace, bounded by the runtime's 12 MiB output limit.
    // Move to indexed rows and paged reads if measured catalog restore exceeds the startup budget.
    guard key.utf8.count <= 1024, value.utf8.count <= 12 * 1024 * 1024 else {
      throw NSError(domain: "Lody.LocalStoreLimit", code: 1)
    }
    try open()
    try transaction {
      try execute("INSERT INTO cache VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
      try indexSession(key, value)
    }
  }

  func write(_ key: String, _ value: String, generation expected: Int?) throws {
    guard expected.map({ $0 == generation }) ?? true else { return }
    try write(key, value)
  }

  private func transaction(_ body: () throws -> Void) throws {
    try execute("BEGIN IMMEDIATE")
    do { try body(); try execute("COMMIT") }
    catch { try? execute("ROLLBACK"); throw error }
  }

  private func indexSession(_ key: String, _ value: String) throws {
    guard key.hasPrefix("session:"),
      let scope = try? JSONSerialization.jsonObject(with: Data(key.dropFirst(8).utf8)) as? [String],
      scope.count == 3, scope.allSatisfy({ !$0.isEmpty }) else { return }
    try execute("DELETE FROM session_prose WHERE user_id = ? AND workspace_id = ? AND session_id = ?", scope)
    for item in SessionProse.extract(value) {
      try execute("INSERT OR REPLACE INTO session_prose VALUES (?, ?, ?, ?, ?, ?)", scope + [item.entryID, item.itemID, item.text])
    }
  }

  private func backfillProse() throws {
    guard try read("session-prose-version") != "1" else { return }
    try transaction {
      let statement = try prepare("SELECT key, value FROM cache WHERE key LIKE 'session:%'", [])
      defer { sqlite3_finalize(statement) }
      while true {
        let status = sqlite3_step(statement)
        if status == SQLITE_DONE { break }
        guard status == SQLITE_ROW else { throw failure() }
        try indexSession(String(cString: sqlite3_column_text(statement, 0)), String(cString: sqlite3_column_text(statement, 1)))
      }
      try execute("INSERT OR REPLACE INTO cache VALUES ('session-prose-version', '1')")
    }
  }

  func searchInbox(userID: String, workspaceID: String, query: String) throws -> [String: Any] {
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !term.isEmpty else { return ["projectIds": [String](), "sessions": [[String: Any]]()] }
    try open()
    try backfillProse()
    let saved = try read("catalog:\(userID):\(workspaceID)") ?? "{}"
    let object = (try? JSONSerialization.jsonObject(with: Data(saved.utf8))) as? [String: Any]
    let catalog = object?["catalog"] as? [String: Any] ?? [:]
    let projects = catalog["projects"] as? [[String: Any]] ?? []
    let sessions = catalog["sessions"] as? [[String: Any]] ?? []
    func matches(_ value: Any?) -> Bool { (value as? String)?.localizedStandardContains(term) == true }
    let projectIDs = projects.compactMap { project -> String? in
      guard let id = project["id"] as? String, !id.hasSuffix(":unassigned"),
        matches(project["name"]) || matches(project["rootPath"]) else { return nil }
      return id
    }
    var hits: [String: Any] = [:]
    for session in sessions {
      guard let id = session["id"] as? String else { continue }
      let projectID = session["projectId"] as? String ?? ""
      let project = projects.first { $0["id"] as? String == projectID }
      let name = projectID.hasSuffix(":unassigned") ? String(localized: "inbox.section.chat", bundle: .lody) : project?["name"] as? String
      if [session["title"], name, session["branchName"], project?["rootPath"]].contains(where: matches) {
        hits[id] = NSNull()
      }
    }
    // ponytail: scan cached prose on the store queue; use FTS if measured search latency outgrows this scope.
    let statement = try prepare("SELECT session_id, text FROM session_prose WHERE user_id = ? AND workspace_id = ? ORDER BY rowid", [userID, workspaceID])
    defer { sqlite3_finalize(statement) }
    while true {
      let status = sqlite3_step(statement)
      if status == SQLITE_DONE { break }
      guard status == SQLITE_ROW else { throw failure() }
      let id = String(cString: sqlite3_column_text(statement, 0))
      if hits[id] != nil { continue }
      let body = String(cString: sqlite3_column_text(statement, 1))
      if let snippet = TextSearch.snippet(body, query: term) { hits[id] = snippet }
    }
    return ["projectIds": projectIDs, "sessions": hits.map { ["id": $0.key, "snippet": $0.value] }]
  }
  func writeSession(_ session: String, userId: String, workspace: String, id: String) throws {
    let data = try JSONSerialization.data(withJSONObject: [userId, workspace, id], options: [.withoutEscapingSlashes])
    guard let suffix = String(data: data, encoding: .utf8) else { return }
    try write("session:" + suffix, session)
  }
  func startup() throws -> [String: String] {
    let started = ProcessInfo.processInfo.systemUptime
    defer {
      #if DEBUG
      NSLog("LodyLocal startup_ms=%.2f", (ProcessInfo.processInfo.systemUptime - started) * 1000)
      #endif
    }
    guard let account = try read("account"),
      let data = account.data(using: .utf8),
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let user = object["user"] as? [String: Any], let id = user["id"] as? String,
      let workspaces = object["workspaces"] as? [[String: Any]] else { return [:] }
    let selection = try read("workspace:\(id)")
    let selected = selection.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0, options: .fragmentsAllowed) as? String }
    let workspace = (workspaces.first { $0["id"] as? String == selected } ?? workspaces.first)?["id"] as? String ?? ""
    return ["account": account, "workspace": workspace, "catalog": try read("catalog:\(id):\(workspace)") ?? "null"]
  }
  func clear() throws {
    generationLock.withLock { currentGeneration += 1 }
    try open()
    try transaction {
      try execute("DELETE FROM cache")
      try execute("DELETE FROM session_prose")
    }
    MarkdownPlainText.clearCache()
  }
}
