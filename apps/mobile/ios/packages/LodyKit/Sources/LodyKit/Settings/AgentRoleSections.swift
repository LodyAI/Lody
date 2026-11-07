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

  static func make(_ roles: [AgentRole], userId: String) -> [LodyListSection] {
    let labels: [RuntimeContract.AgentRoleItemVisibility: String] = [.private: text("private"), .workspace: text("sharedValue")]
    var section = LodyListSection()
    section.id = "roles"
    section.footer = text("hint")
    section.rows = roles.map { role in
      let targets = role.targets.map { target in
        let state = target.state == .configured ? "" : " · \(text(target.state.rawValue))"
        return "\(target.machineName) · \(target.agentName)\(state)"
      }
      let owner = role.ownerUserId != userId ? text("ownerOnly") : ""
      var row = LodyListRow()
      row.id = "role:\(role.id)"
      row.title = role.name
      row.image = "person.crop.square"
      row.subtitle = ([role.description] + targets + [owner]).filter { !$0.isEmpty }.joined(separator: "\n")
      row.wrapSubtitle = true
      row.value = labels[role.visibility] ?? ""
      row.accessibilityValue = row.value
      row.action = true
      row.disclosure = true
      return row
    }
    return [section]
  }

  static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue("settings.roles." + key), bundle: .lody)
  }
}
