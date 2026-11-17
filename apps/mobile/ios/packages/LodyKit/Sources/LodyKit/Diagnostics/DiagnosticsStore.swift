import CryptoKit
import Darwin
import Foundation

/// Only structured metadata enters diagnostics; never pass payloads, tokens or error descriptions.
final class DiagnosticsStore: @unchecked Sendable {
  enum Process: String, CaseIterable, Sendable {
    case app, notificationService
  }

  static let shared = DiagnosticsStore(
    directory: storageRoot,
    process: Bundle.main.bundleIdentifier?.hasSuffix(".notification-service") == true ? .notificationService : .app
  )

  private static var storageRoot: URL {
    #if os(iOS)
    let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.ai.lody.mobile")
    let root = group ?? URL.applicationSupportDirectory
    #else
    let root = URL.applicationSupportDirectory
    #endif
    let name = CommandLine.arguments.contains("--ui-verify") ? "DiagnosticsVerify" : "Diagnostics"
    return root.appending(path: name)
  }

  let directory: URL
  private let process: Process
  private let maxBytes: Int
  private let retention: TimeInterval = 7 * 86400
  private let now: @Sendable () -> Date
  private let queue = DispatchQueue(label: "ai.lody.mobile.diagnostics", qos: .utility)
  private var lastPruned: Date?
  private var dropped = 0

  private struct Entry: Codable {
    let at: Date
    let process: String
    let category: String
    let event: String
    let fields: [String: String]
  }

  init(directory: URL, process: Process, maxBytes: Int = 5 * 1024 * 1024,
       now: @escaping @Sendable () -> Date = { Date() }) {
    self.directory = directory
    self.process = process
    self.maxBytes = maxBytes
    self.now = now
  }

  static func correlation(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
  }

  static func attachmentServerCode(_ value: String?) -> String? {
    guard let value, value.utf8.count <= 64 else { return nil }
    let code = value.lowercased().replacingOccurrences(of: " ", with: "_").replacingOccurrences(of: "-", with: "_")
    let allowed = ["unauthorized", "forbidden", "not_found", "quota_exceeded", "storage_quota_exceeded",
                   "payload_too_large", "file_too_large", "unsupported_media_type", "invalid_request", "bad_request",
                   "rate_limited", "rate_limit_exceeded", "internal_server_error", "service_unavailable"]
    return allowed.contains(code) ? code : nil
  }

  static func attachmentMediaType(_ value: String) -> String {
    let allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]
    return allowed.contains(value) ? value : "other"
  }

  func navigation(id: String, source: String, outcome: String, reason: String) {
    var fields = ["source": source, "reason": reason]
    if source == "notification", UUID(uuidString: id) != nil { fields["message"] = id }
    else if source == "deep-link", id.hasPrefix("link:"), let link = Int(id.dropFirst(5)), link > 0 { fields["link"] = String(link) }
    else { return }
    switch outcome {
    case "wait": record("notification", "navigation_wait", fields: fields)
    case "workspace": record("notification", "workspace_change_requested", fields: fields)
    case "discard": record("notification", "navigation_discarded", fields: fields)
    case "session": record("notification", "session_open_requested", fields: fields)
    case "reset": record("notification", "navigation_reset_requested", fields: fields)
    default: return
    }
  }

  func record(_ category: StaticString, _ event: StaticString, fields: [String: String] = [:]) {
    let entry = Entry(at: now(), process: process.rawValue, category: category.description,
                      event: event.description, fields: Self.metadata(fields))
    queue.async {
      do { try self.withLock { try self.append(entry) } }
      catch { self.dropped += 1 }
    }
  }

  // Extension completion and background suspension must not strand queued records.
  func flush() { queue.sync {} }

  func count(since window: TimeInterval) throws -> Int {
    try queue.sync { try withLock { try entries(since: window).count } }
  }

  func export(since window: TimeInterval) throws -> URL {
    try queue.sync {
      let records = try withLock { try entries(since: window) }
      let info = Bundle.main.infoDictionary ?? [:]
      let appVersion = info["CFBundleShortVersionString"] as? String ?? "unknown"
      let build = info["CFBundleVersion"] as? String ?? "unknown"
      var data = Data("Lody diagnostics\nApp: \(appVersion) (\(build))\nOS: \(ProcessInfo.processInfo.operatingSystemVersionString)\nExported: \(now().ISO8601Format())\nSince: \(now().addingTimeInterval(-window).ISO8601Format())\nRecords: \(records.count)\nRecords not written in this app process: \(dropped)\nTimestamps: milliseconds since 1970 (UTC)\n\nDescribe what happened and the approximate time when sharing this file.\nEvents are observations, not proof of push delivery. Missing events have an unknown outcome.\n\n".utf8)
      for entry in records {
        data.append(try Self.encoder().encode(entry))
        data.append(10)
      }
      let folder = FileManager.default.temporaryDirectory.appending(path: "LodyDiagnostics/\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let file = folder.appending(path: "diagnostics.txt")
      try Self.write(data, to: file)
      return file
    }
  }

  func clear() throws {
    try queue.sync {
      try withLock {
        for source in Process.allCases {
          for file in files(source) where FileManager.default.fileExists(atPath: file.path) {
            try FileManager.default.removeItem(at: file)
          }
        }
        lastPruned = nil
        dropped = 0
      }
    }
  }

  private func withLock<T>(_ work: () throws -> T) throws -> T {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var root = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try root.setResourceValues(values)
    let fd = open(directory.appending(path: "store.lock").path, O_CREAT | O_RDWR, 0o600)
    guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    defer { close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    defer { flock(fd, LOCK_UN) }
    return try work()
  }

  private func files(_ source: Process) -> [URL] {
    let folder = directory.appending(path: source.rawValue)
    return ["previous.jsonl", "current.jsonl"].map { folder.appending(path: $0) }
  }

  private func append(_ entry: Entry) throws {
    if lastPruned.map({ now().timeIntervalSince($0) >= 3600 }) ?? true {
      for source in Process.allCases { try prune(source) }
      lastPruned = now()
    }
    var data = try Self.encoder().encode(entry)
    data.append(10)
    let fileLimit = maxBytes / (Process.allCases.count * 2)
    guard data.count <= fileLimit else { dropped += 1; return }
    let paths = files(process)
    let file = paths[1]
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    if size + data.count > fileLimit {
      if FileManager.default.fileExists(atPath: paths[0].path) { try FileManager.default.removeItem(at: paths[0]) }
      if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.moveItem(at: file, to: paths[0]) }
    }
    if !FileManager.default.fileExists(atPath: file.path) { try Self.write(Data(), to: file) }
    let handle = try FileHandle(forWritingTo: file)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: data)
  }

  private static func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .millisecondsSince1970
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }

  private static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .millisecondsSince1970
    return decoder
  }

  private static func write(_ data: Data, to file: URL) throws {
    #if os(iOS)
    try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
    try data.write(to: file, options: .atomic)
    #endif
  }

  private func read(_ file: URL) throws -> [Entry] {
    guard FileManager.default.fileExists(atPath: file.path) else { return [] }
    guard (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= maxBytes else {
      throw NSError(domain: "Lody.Diagnostics.Size", code: 1)
    }
    let decoder = Self.decoder()
    let lines = try Data(contentsOf: file).split(separator: 10)
    let records = lines.compactMap { try? decoder.decode(Entry.self, from: Data($0)) }
    if records.count != lines.count {
      dropped += lines.count - records.count
      var repaired = Data()
      for record in records { repaired.append(try Self.encoder().encode(record)); repaired.append(10) }
      try Self.write(repaired, to: file)
    }
    return records
  }

  private func prune(_ source: Process) throws {
    let cutoff = now().addingTimeInterval(-retention)
    for file in files(source) {
      let records = try read(file)
      let kept = records.filter { $0.at.timeIntervalSinceReferenceDate >= cutoff.timeIntervalSinceReferenceDate }
      guard kept.count != records.count else { continue }
      var data = Data()
      for entry in kept { data.append(try Self.encoder().encode(entry)); data.append(10) }
      try Self.write(data, to: file)
    }
  }

  private func entries(since window: TimeInterval) throws -> [Entry] {
    guard [900, 3600, 86400, 604800].contains(window) else {
      throw NSError(domain: "Lody.Diagnostics.Range", code: 1)
    }
    let cutoff = now().addingTimeInterval(-window)
    var records: [Entry] = []
    for source in Process.allCases {
      try prune(source)
      for file in files(source) { records += try read(file).filter { $0.at.timeIntervalSinceReferenceDate >= cutoff.timeIntervalSinceReferenceDate } }
    }
    return records.sorted { $0.at < $1.at }
  }

  static func syncCode(_ value: String) -> String? {
    let bytes = Array(value.utf8)
    guard (1...48).contains(bytes.count), (97...122).contains(bytes[0]),
          bytes.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 95 }) else { return nil }
    return value
  }

  private static func metadata(_ fields: [String: String]) -> [String: String] {
    fields.filter { key, value in
      switch key {
      case "activity", "native", "session", "serverErrorFingerprint":
        return value.count == 16 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
      case "message", "attempt", "oneSignalApp", "requestId": return UUID(uuidString: value) != nil
      case "stage":
        return ["image_upload", "file_upload", "multipart_create", "multipart_part", "multipart_complete", "multipart_abort"].contains(value)
      case "httpStatus": return Int(value).map { (100...599).contains($0) } ?? false
      case "cfRay":
        return value.utf8.count <= 36 && value.range(of: "^[0-9a-f]{16,32}-[A-Z]{3}$", options: .regularExpression) != nil
      case "requestBytes", "responseBytes", "sourceBytes", "imageBytes", "sessionBytes", "elapsedMs":
        return value.utf8.count <= 16 && !value.isEmpty && value.utf8.allSatisfy { (48...57).contains($0) }
      case "sourceType", "uploadType": return Self.attachmentMediaType(value) == value
      case "converted": return ["true", "false"].contains(value)
      case "responseType": return ["json", "html", "text", "other", "missing"].contains(value)
      case "responseBody": return ["empty", "too_large", "json_object", "json_other", "invalid_json"].contains(value)
      case "serverCodeState": return ["recognized", "unrecognized", "missing"].contains(value)
      case "networkCode": return Int(value) != nil
      case "serverCode": return Self.attachmentServerCode(value) == value
      case "hasToken", "enabled", "identified", "authorized", "current", "configured", "registered", "accepted",
           "hasView", "contractReady", "handshakeDeferred":
        return value == "true" || value == "false"
      case "active", "unread", "serverUpdatedAt", "staleDate", "appState", "observed", "activities", "code", "count", "sessions", "link",
           "ageMs", "attempts", "generation":
        return value.count <= 32 && Double(value)?.isFinite == true
      case "build": return value.count <= 32 && value.utf8.allSatisfy { (48...57).contains($0) || $0 == 46 }
      case "source": return ["current", "stream", "notification", "deep-link", "local"].contains(value)
      case "state": return ["active", "stale", "ended", "dismissed"].contains(value)
      case "readStage": return ["bootstrap", "catchup", "poll"].contains(value)
      case "syncStatus", "runtimePhase":
        return ["starting", "syncing", "live", "offline", "background", "failed", "stopped"].contains(value)
      case "syncCode", "runtimeReason": return Self.syncCode(value) == value
      case "permission": return ["notDetermined", "denied", "authorized", "provisional", "ephemeral"].contains(value)
      case "reason":
        return ["start", "background", "foreground", "catalog_inactive", "create_cancelled", "toggle_off",
                "identity_missing", "identity_changed", "owner_or_toggle_rejected", "explicit_end_all",
                "workspace_changed", "native_activity_replaced", "system_ended", "system_dismissed",
                "signed_out", "wrong_account", "visible_session", "invalid_payload", "not_ready",
                "unknown_route", "no_workspace", "session_missing", "catalog_sync", "ready"].contains(value)
      default: return false
      }
    }
  }
}
