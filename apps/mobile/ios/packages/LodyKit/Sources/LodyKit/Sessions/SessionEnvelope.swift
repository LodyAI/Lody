import Foundation

struct SessionBrowserPreview: Equatable, Sendable {
  var label: String
  var active: Bool
}

struct SessionEnvelope: Sendable {
  var version: Int?
  var revision: Int?
  var status = ""
  var overflow = false
  var entriesJSON = "[]"
  var billableTurnCount: Int?
  var composerJSON: String?
  var preview: SessionBrowserPreview?
  var transcript = SessionTranscriptFacts()

  static func prepare(_ json: String) -> SessionEnvelope? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return nil }
    var envelope = SessionEnvelope(
      version: (object["v"] as? NSNumber)?.intValue, revision: (object["revision"] as? NSNumber)?.intValue,
      status: object["status"] as? String ?? "", overflow: object["overflow"] as? Bool == true
    )
    if let preview = object["preview"] as? [String: Any], let label = preview["label"] as? String {
      envelope.preview = SessionBrowserPreview(label: label, active: preview["active"] as? Bool == true)
    }
    envelope.billableTurnCount = (object["billableTurnCount"] as? NSNumber)?.intValue
    if let composer = object["composer"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: composer) {
      envelope.composerJSON = String(decoding: data, as: UTF8.self)
    }
    guard let entries = object["entries"] as? [[String: Any]] else { return envelope }
    envelope.transcript = SessionTranscriptFacts(entries: entries)
    let augmented = entries.map { entry in entry.merging(["fileDiffs": changedFiles(entry)]) { _, new in new } }
    if let data = try? JSONSerialization.data(withJSONObject: augmented) {
      envelope.entriesJSON = String(decoding: data, as: UTF8.self)
    }
    return envelope
  }

  static func changedFiles(_ entry: [String: Any]) -> [[String: Any]] {
    func count(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    var order: [String] = []
    var files: [String: [String: Any]] = [:]
    let diffs = entry["fileDiffs"] as? [[String: Any]] ?? []
    let recorded = Set(diffs.compactMap { $0["path"] as? String })
    for diff in diffs {
      guard let path = diff["path"] as? String else { continue }
      if files[path] == nil { order.append(path) }
      files[path] = ["path": path, "add": count(diff["add"]), "del": count(diff["del"]), "status": "M"]
    }
    for item in entry["items"] as? [[String: Any]] ?? [] {
      guard item["type"] as? String == "tool_call", let path = item["path"] as? String, !path.isEmpty else { continue }
      let kind = item["kind"] as? String ?? ""
      guard kind != "read", kind != "search", !recorded.contains(path) else { continue }
      let status = ["delete": "D", "write": "A"][kind] ?? "M"
      if var existing = files[path] {
        existing["add"] = count(existing["add"]) + count(item["added"])
        existing["del"] = count(existing["del"]) + count(item["removed"])
        if status == "D" { existing["status"] = "D" }
        files[path] = existing
      } else {
        order.append(path)
        files[path] = ["path": path, "add": count(item["added"]), "del": count(item["removed"]), "status": status]
      }
    }
    return order.compactMap { files[$0] }
  }

  func accepted(generation: Int, after cursor: (generation: Int, revision: Int)) -> Bool {
    guard version == 1, generation >= cursor.generation else { return false }
    if generation > cursor.generation { return revision != nil }
    return (revision ?? .min) > cursor.revision
  }
}

struct SessionItemTarget: Equatable, Sendable {
  var entryId: String
  var itemId: String
  var detail: String
}

struct SessionTranscriptFacts: Equatable, Sendable {
  static let recoverable: Set<String> = [
    "acp_provider_overloaded", "acp_upstream_api_error", "acp_internal_error", "acp_unknown_error",
    "agent_disconnected", "agent_no_output", "acp_not_ready",
  ]

  var permission: SessionPermission?
  var permissionError: String?
  var entryIds: Set<String> = []
  var replied: Set<String> = []
  var delivered: Set<String> = []
  var answered: Set<String> = []
  var unfinishedTurnId: String?
  var conversational = false
  var proposedPlan: SessionItemTarget?
  var retryableError: SessionItemTarget?
  var editableUserId: String?
  var editEligibility = ""

  init() {}

  init(entries: [[String: Any]]) {
    do { permission = try SessionPermission.first(in: entries) }
    catch { permissionError = error.localizedDescription }
    proposedPlan = Self.latestProposedPlan(entries)
    retryableError = Self.latestRetryableError(entries)
    var assistantSeen = false
    for entry in entries.reversed() {
      if assistantSeen, let id = entry["id"] as? String { answered.insert(id) }
      if entry["role"] as? String == "assistant" { assistantSeen = true }
    }
    let latest = entries.lastIndex { $0["role"] as? String == "user" && $0["status"] as? String != "queued" }
    let goal = entries.last { ($0["items"] as? [[String: Any]] ?? []).contains { $0["type"] as? String == "goal" } }
    if let latest {
      editableUserId = entries[latest]["id"] as? String
      let preceding = latest > 0 ? entries[latest - 1] : [:]
      editEligibility = [
        editableUserId ?? "", entries[latest]["status"] as? String ?? "", preceding["id"] as? String ?? "",
        "\(preceding["finished"] as? Bool ?? false)", goal?["id"] as? String ?? "", "\(goal?["rev"] ?? "")",
      ].joined(separator: ":")
    }
    var preceding: String?
    for entry in entries {
      guard let id = entry["id"] as? String else { continue }
      entryIds.insert(id)
      if let delivery = entry["delivery"] as? String, !delivery.isEmpty { delivered.insert(id) }
      switch entry["role"] as? String {
      case "user":
        preceding = id
        conversational = true
      case "assistant":
        conversational = true
        if let target = entry["userTurnId"] as? String ?? preceding { replied.insert(target) }
        if entry["finished"] as? Bool != true { unfinishedTurnId = id }
      default:
        break
      }
    }
  }

  static func latestProposedPlan(_ entries: [[String: Any]]) -> SessionItemTarget? {
    for entry in entries.reversed() {
      // A subsequent user turn consumes the previous decision even after remount.
      if entry["role"] as? String == "user" { return nil }
      for item in (entry["items"] as? [[String: Any]] ?? []).reversed() {
        guard item["type"] as? String == "proposed_plan", let markdown = item["markdown"] as? String else { continue }
        guard item["status"] as? String == "completed", item["isLatest"] as? Bool == true,
              !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let entryId = entry["id"] as? String, let itemId = item["itemId"] as? String else { return nil }
        return SessionItemTarget(entryId: entryId, itemId: itemId, detail: item["turnId"] as? String ?? "")
      }
    }
    return nil
  }

  static func latestRetryableError(_ entries: [[String: Any]]) -> SessionItemTarget? {
    for entry in entries.reversed() {
      if entry["role"] as? String == "user" { return nil }
      for item in (entry["items"] as? [[String: Any]] ?? []).reversed() {
        guard item["type"] as? String == "system_notice", item["name"] as? String == "chat_failed" else { continue }
        let meta = item["meta"] as? [String: Any] ?? [:]
        let reason = meta["reason"] as? String ?? ""
        guard recoverable.contains(reason), meta["code"] as? String != "git_executable_not_found",
              let entryId = entry["id"] as? String, let itemId = item["itemId"] as? String else { return nil }
        return SessionItemTarget(entryId: entryId, itemId: itemId, detail: reason)
      }
    }
    return nil
  }
}
