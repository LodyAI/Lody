import Foundation

final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var value = Date(timeIntervalSince1970: 1_800_000_000)
  func read() -> Date { lock.withLock { value } }
  func advance(_ seconds: TimeInterval) { lock.withLock { value.addTimeInterval(seconds) } }
}

func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw NSError(domain: message, code: 1) }
}

func exported(_ store: DiagnosticsStore) throws -> (String, [[String: Any]]) {
  let file = try store.export(since: 604800)
  defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
  let text = try String(contentsOf: file, encoding: .utf8)
  let records = try text.split(separator: "\n").filter { $0.hasPrefix("{") }.map {
    try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any]
  }
  return (text, records)
}

let root = FileManager.default.temporaryDirectory.appending(path: "lody-diagnostics-check-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: root) }
let clock = Clock()
let app = DiagnosticsStore(directory: root, process: .app, now: { clock.read() })
let service = DiagnosticsStore(directory: root, process: .notificationService, now: { clock.read() })
let message = "3327c0d1-727b-4af6-8e0f-3f27098d15df"

do {
  app.record("app", "launch")
  app.flush()
  clock.advance(1800)
  service.record("notification", "extension_received", fields: ["message": message])
  service.flush()
  clock.advance(1800)
  app.navigation(id: message, source: "notification", outcome: "discard", reason: "wrong_account")
  app.flush()
  try expect(app.count(since: 900) == 1, "Fifteen-minute selection excludes older events")
  try expect(app.count(since: 3600) == 3, "Events exactly on the range boundary are included")
  let restored = DiagnosticsStore(directory: root, process: .app, now: { clock.read() })
  try expect(restored.count(since: 86400) == 3, "Records survive a new store instance")
  let (_, records) = try exported(restored)
  try expect(records.count == 3, "App and extension records are merged")
  let dates = records.map { $0["at"] as! Double }
  try expect(dates == dates.sorted(), "Export sorts interleaved processes by time")
  try expect((records.last?["fields"] as? [String: String])?["reason"] == "wrong_account", "Rejection reason is useful without route content")

  app.record("notification", "privacy", fields: ["body": "private conversation", "token": "private-token",
    "message": "private-id", "reason": "private-account", "code": "credential", "active": "2", "activity": DiagnosticsStore.correlation("private-activity"),
    "stage": "private-stage", "serverCode": "private-server-code", "httpStatus": "999", "networkCode": "private-network-code"])
  app.flush()
  let (text, privacyRecords) = try exported(app)
  try expect((privacyRecords.last?["fields"] as? [String: String])?["httpStatus"] == nil, "Export excludes invalid HTTP status values")
  for secret in ["private conversation", "private-token", "private-id", "private-account", "private-activity", "credential", "private-stage", "private-server-code", "private-network-code"] {
    try expect(!text.contains(secret), "Export excludes unapproved or unvalidated metadata")
  }
  try expect(DiagnosticsStore.correlation("abc") == "ba7816bf8f01cfea", "Activity correlation matches the server SHA-256 prefix")
  let syncFields = ["session": DiagnosticsStore.correlation("session-1"), "readStage": "poll", "syncCode": "timeout_error",
    "ageMs": "35012", "attempts": "2", "syncStatus": "syncing"]
  app.record("session-sync", "read_retry", fields: syncFields)
  app.record("session-sync", "runtime_resume", fields: ["hasView": "true", "contractReady": "false", "handshakeDeferred": "true",
    "runtimePhase": "live", "runtimeReason": "machine_presence"])
  app.record("session-sync", "privacy", fields: ["session": "private-session", "readStage": "private-read",
    "syncCode": "https://private.host/path", "syncStatus": "private-status", "ageMs": "private-age",
    "runtimePhase": "private-phase", "runtimeReason": "Private Reason", "hasView": "private-bool"])
  app.flush()
  let (syncText, syncRecords) = try exported(app)
  let retry = syncRecords.first { $0["event"] as? String == "read_retry" }?["fields"] as? [String: String]
  try expect(retry == syncFields, "Session sync records keep read stage, code, age, attempts and status")
  let resume = syncRecords.first { $0["event"] as? String == "runtime_resume" }?["fields"] as? [String: String]
  try expect(resume?.count == 5, "Runtime resume keeps view, contract, handshake, phase and reason")
  for secret in ["private-session", "private-read", "private.host", "private-status", "private-age", "private-phase", "Private Reason", "private-bool"] {
    try expect(!syncText.contains(secret), "Session sync metadata rejects unvalidated values")
  }
  let before = try app.count(since: 86400)
  app.navigation(id: "a secret instead of a UUID", source: "notification", outcome: "session", reason: "")
  app.navigation(id: message, source: "untrusted source", outcome: "session", reason: "")
  app.navigation(id: message, source: "notification", outcome: "arbitrary event", reason: "")
  app.flush()
  try expect(app.count(since: 86400) == before, "The native bridge rejects arbitrary diagnostic input")

  let current = root.appending(path: "app/current.jsonl")
  let handle = try FileHandle(forWritingTo: current)
  try handle.seekToEnd()
  try handle.write(contentsOf: Data("{interrupted-write".utf8))
  try handle.close()
  try expect(app.count(since: 86400) == before, "An interrupted final record does not hide valid history")
  let (repaired, _) = try exported(app)
  try expect(repaired.contains("Records not written in this app process: 1"), "Export reports capture gaps")
  app.record("app", "after_repair")
  app.flush()
  try expect(app.count(since: 86400) == before + 1, "Writing continues after a truncated record")

  let unrelated = root.appending(path: "unrelated.txt")
  try Data("keep".utf8).write(to: unrelated)
  try app.clear()
  try expect(service.count(since: 604800) == 0, "Clear removes both processes' diagnostics")
  try expect(FileManager.default.fileExists(atPath: unrelated.path), "Clear preserves unrelated files and the shared lock")
  for index in 0..<100 {
    app.record("app", "concurrent", fields: ["count": String(index)])
    service.record("notification", "concurrent", fields: ["count": String(index)])
  }
  app.flush()
  service.flush()
  try expect(app.count(since: 86400) == 200, "Independent writer queues preserve both processes' events")
  clock.advance(7 * 86400 + 1)
  app.record("app", "after_retention")
  app.flush()
  let extensionFile = root.appending(path: "notificationService/current.jsonl")
  try expect(Data(contentsOf: extensionFile).isEmpty, "An app write also removes expired extension history")
  try expect(app.count(since: 604800) == 1, "Expired entries are removed while new events are retained")

  let smallRoot = root.appending(path: "small")
  let small = DiagnosticsStore(directory: smallRoot, process: .app, maxBytes: 4096)
  let smallExtension = DiagnosticsStore(directory: smallRoot, process: .notificationService, maxBytes: 4096)
  for index in 0..<100 {
    small.record("app", "rolling", fields: ["count": String(index)])
    smallExtension.record("notification", "rolling", fields: ["count": String(index)])
  }
  small.flush()
  smallExtension.flush()
  let (_, rolled) = try exported(small)
  try expect(rolled.count < 200 && rolled.count > 0, "Capacity pressure evicts older history")
  let counts = rolled.compactMap { ($0["fields"] as? [String: String])?["count"] }
  try expect(counts.contains("99") && !counts.contains("0"), "Rolling storage retains the newest events")
  let files = FileManager.default.enumerator(at: smallRoot, includingPropertiesForKeys: [.fileSizeKey])!
  var bytes = 0
  for case let file as URL in files where file.pathExtension == "jsonl" { bytes += try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0 }
  try expect(bytes <= 4096, "The two processes share one total byte ceiling")

  let blocked = root.appending(path: "blocked")
  try Data().write(to: blocked)
  let failing = DiagnosticsStore(directory: blocked, process: .app)
  failing.record("app", "failed_write")
  failing.flush()
  do { _ = try failing.count(since: 900); throw NSError(domain: "Read failure was hidden", code: 1) }
  catch let error as NSError { try expect(error.domain != "Read failure was hidden", "Storage failures are observable") }
  do { _ = try app.count(since: .infinity); throw NSError(domain: "Invalid range was accepted", code: 1) }
  catch let error as NSError { try expect(error.domain == "Lody.Diagnostics.Range", "Range input is validated natively") }
  print("Diagnostics: range, restart, merge, privacy, interrupted write, clear, concurrent writers, retention and rotation passed")
} catch {
  fatalError("Diagnostics check failed: \(error)")
}
