import Foundation
import LodyCore

typealias AgentRole = RuntimeContract.AgentRoleItem
typealias AgentRoleAgent = RuntimeContract.AgentRoleSnapshotAgentsItem
typealias AgentRoleSnapshot = RuntimeContract.AgentRoleSnapshot

enum AgentRoleRequest: Sendable {
  case list
  case save(id: String, base: AgentRole?, fields: RuntimeContract.AgentRolesParamsSaveFields, target: RuntimeContract.AgentRolesParamsSaveTarget?)
  case delete(AgentRole)
}

typealias AgentRoleService = @MainActor (AgentRoleRequest) async throws -> AgentRoleSnapshot

enum AgentRoleSections {
  static func editable(_ role: AgentRole, userId: String) -> Bool {
    role.ownerUserId == userId && role.name.unicodeScalars.count <= 60
      && role.description.unicodeScalars.count <= 140 && role.promptPrefix.utf16.count <= 32000
  }

  static func readOnlyHint(_ role: AgentRole, userId: String) -> String? {
    if role.ownerUserId != userId { return text("readOnly") }
    if !editable(role, userId: userId) { return text("longReadOnly") }
    return nil
  }

  // Any unrecognised failure may have followed a durable write; only a fresh read can tell.
  static func failure(_ error: any Error) -> (message: String, uncertain: Bool) {
    let value = "\(error) \(error.localizedDescription)"
    let keys = [
      ("role_read_only", "settings.roles.readOnly"),
      ("role_conflict", "settings.remote.conflict"),
      ("role_duplicate", "settings.roles.duplicate"),
      ("role_forbidden", "settings.roles.accessDenied"),
      ("role_target_unavailable", "settings.roles.targetUnavailable"),
      ("role_invalid", "settings.roles.invalid"),
    ]
    for (code, key) in keys where value.contains(code) { return (String(localized: String.LocalizationValue(key), bundle: .lody), false) }
    return (text("unknown"), true)
  }

  /// Web `DEFAULT_AGENT_ROLE_EMOJI`.
  static let defaultEmoji = "🪼"

  /// Your Roles first, then the workspace's shared ones; each row leads with its emoji and
  /// reads its description (else where it runs) on the second line.
  static func make(_ roles: [AgentRole], userId: String) -> [LodyListSection] {
    let mine = roles.filter { $0.ownerUserId == userId }
    let others = roles.filter { $0.ownerUserId != userId }
    var sections: [LodyListSection] = []
    for (id, header, items) in [("mine", text("mine"), mine), ("shared", text("sharedByOthers"), others)] where !items.isEmpty {
      var section = LodyListSection()
      section.id = id
      section.header = header
      section.rows = items.map { row($0, mine: id == "mine") }
      sections.append(section)
    }
    if !sections.isEmpty { sections[sections.count - 1].footer = text("hintShort") }
    return sections
  }

  private static func row(_ role: AgentRole, mine: Bool) -> LodyListRow {
    var row = LodyListRow()
    row.id = "role:\(role.id)"
    row.title = role.name
    row.emoji = role.emoji ?? defaultEmoji
    row.imageOriginal = true
    let unavailable = role.targets.contains { $0.state != .configured }
    let place = role.targets.map { "\($0.agentName) · \($0.machineName)" }.first ?? ""
    let summary = role.description.trimmingCharacters(in: .whitespacesAndNewlines)
    row.subtitle = summary.isEmpty ? place : summary
    if unavailable {
      let state = role.targets.first { $0.state != .configured }?.state.rawValue ?? ""
      row.subtitle = [text(state), row.subtitle].filter { !$0.isEmpty }.joined(separator: " · ")
    }
    if mine {
      row.value = text(role.visibility == .workspace ? "sharedValue" : "private")
    }
    row.accessibilityValue = row.value
    row.action = true
    row.disclosure = true
    row.navigates = true
    return row
  }

  static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue("settings.roles." + key), bundle: .lody)
  }
}
