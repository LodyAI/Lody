import LodyCore
import Foundation

// Byte-compatible with features/sessions/createDraft.ts, which the Share drain still uses.
struct CreateDraftRecord {
  let recordJSON: String
  let createdJSON: String

  var record: OutboxRecord? { OutboxRecord.decode(recordJSON) }
  var created: Any? { try? JSONSerialization.jsonObject(with: Data(createdJSON.utf8)) }

  init(
    draft: CreateSessionDraft, payload: [String: Any], createdAt: String = Self.now(),
    text label: (String) -> String = { String(localized: String.LocalizationValue($0), bundle: .lody) }
  ) {
    let agent = draft.agent
    let message = payload["text"] as? String ?? ""
    let title = Self.title(message, fallback: label("session.newTitle"))
    let session = Self.object([
      ("id", Self.string(draft.sessionId)),
      ("projectId", Self.string(draft.projectId ?? "\(agent.machineId):unassigned")),
      ("machineId", Self.string(agent.machineId)),
      ("cliType", Self.string(agent.cliType)),
      ("agentType", Self.string(agent.agentType)),
      ("title", Self.string(title)),
      ("status", Self.string("idle")),
      ("archived", "false"),
      ("pinned", "false"),
      ("createdAt", Self.string(createdAt)),
    ])
    var creation: [(String, String)] = [
      ("workspaceId", Self.string(draft.workspaceId)),
      ("sessionId", Self.string(draft.sessionId)),
      ("machineId", Self.string(agent.machineId)),
      ("agentConfigId", Self.string(agent.id)),
      ("userId", Self.string(draft.userId)),
      ("title", Self.string(title)),
    ]
    if let projectId = draft.projectId, !projectId.isEmpty {
      // A multi-repository project is created by group: the runtime reads it fresh.
      if projectId.hasPrefix(CreateSessionSelection.groupPrefix) {
        creation.append(("projectGroupId", Self.string(String(projectId.dropFirst(CreateSessionSelection.groupPrefix.count)))))
      } else {
        creation.append(("projectId", Self.string(projectId)))
      }
    }
    if let branch = draft.branch, !branch.isEmpty { creation.append(("branch", Self.string(branch))) }
    if draft.useWorktree == true { creation.append(("useWorktree", "true")) }
    // The Role the session starts as: provenance on its metadata, and the first turn's Role,
    // which the runtime re-reads and applies (prompt prefix, memory) or refuses.
    if let role = draft.agentRoleId, let revision = draft.agentRoleRevision {
      creation.append(("agentRoleId", Self.string(role)))
      creation.append(("agentRoleRevision", String(revision)))
    }
    let choiceFields = Self.fields(CreateJSON.encode(draft.choice))
    var sendChoice = choiceFields
    if let effort = draft.reasoningEffortConfigId { sendChoice.append(("reasoningEffortConfigId", Self.string(effort))) }
    let send = Self.object([
      ("id", Self.string(payload["id"] as? String ?? "")),
      ("text", Self.string(message)),
      ("startedAt", Self.number(payload["startedAt"])),
      ("attachments", Self.raw(payload["attachments"] ?? [])),
      ("phase", Self.string("waiting")),
      ("choice", Self.object(sendChoice)),
      ("creation", Self.string(Self.object(creation))),
    ] + (draft.agentRoleId.map { [("agentRoleId", Self.string($0))] } ?? []))
    recordJSON = Self.object([("session", session), ("send", send)])
    let projectName = draft.projectId?.isEmpty == false ? draft.projectName : label("inbox.section.chat")
    createdJSON = Self.object([
      ("composerRelayId", Self.string(payload["id"] as? String ?? "")),
      ("session", session),
      ("projectName", Self.string(projectName)),
      ("machineName", Self.string(agent.machineName)),
    ] + choiceFields)
  }

  static func title(_ draft: String, fallback: String) -> String {
    let line = draft.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
      .first { !$0.isEmpty }?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if line.isEmpty { return fallback }
    let scalars = Array(line.unicodeScalars)
    guard scalars.count > 24 else { return line }
    return String(String.UnicodeScalarView(scalars.prefix(24))) + "…"
  }

  static func now() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
  }

  private static func object(_ fields: [(String, String)]) -> String {
    "{" + fields.map { string($0.0) + ":" + $0.1 }.joined(separator: ",") + "}"
  }

  private static func string(_ value: String) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
  }

  private static func number(_ value: Any?) -> String {
    let number = (value as? NSNumber)?.doubleValue ?? 0
    if number.rounded() == number, abs(number) < 1e15 { return String(Int64(number)) }
    return raw(number)
  }

  private static func raw(_ value: Any) -> String {
    let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed])
    return data.map { String(decoding: $0, as: UTF8.self) } ?? "null"
  }

  private static func fields(_ json: String) -> [(String, String)] {
    guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return [] }
    return object.keys.sorted().map { ($0, raw(object[$0] as Any)) }
  }
}
