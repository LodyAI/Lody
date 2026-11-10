import Foundation

struct SettingsMachinePresence: Decodable, Equatable, Sendable {
  var state = "unknown"
  var onlineMachineIds: [String] = []

  static let unknown = SettingsMachinePresence()

  func status(of machine: String) -> String {
    guard state == "live" else { return "unknown" }
    return onlineMachineIds.contains(machine) ? "online" : "offline"
  }
}

struct SettingsProject: Decodable, Equatable, Sendable {
  var id: String
  var machineId: String
  var name: String
  var rootPath: String
}

struct SettingsCatalog: Decodable, Equatable, Sendable {
  var projects: [SettingsProject] = []
  var machineNames: [String: String] = [:]

  init(projects: [SettingsProject] = [], machineNames: [String: String] = [:]) {
    self.projects = projects
    self.machineNames = machineNames
  }

  private enum CodingKeys: String, CodingKey { case projects, sessions, machineIds, machineNames }
  private struct Opaque: Decodable {
    init(from decoder: any Decoder) throws {}
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    _ = try container.decode([Opaque].self, forKey: .sessions)
    _ = try container.decode([Opaque].self, forKey: .machineIds)
    projects = try container.decode([SettingsProject].self, forKey: .projects)
    machineNames = (try? container.decodeIfPresent([String: String].self, forKey: .machineNames)) ?? [:]
  }
}

struct SettingsWorkspace: Equatable, Sendable {
  var userId = ""
  var workspaceId = ""
  var connected = true
  var presence = SettingsMachinePresence.unknown
  var catalog = SettingsCatalog()

  var key: String { userId.isEmpty || workspaceId.isEmpty ? "" : "\(userId):\(workspaceId)" }

  static func decode(state: String, raw: String) -> SettingsWorkspace {
    struct Scoped: Decodable {
      var workspaceId = ""
      var presence = SettingsMachinePresence.unknown
    }
    struct State: Decodable {
      var userId = ""
      var workspaceId = ""
      var connected = false
      var presence: Scoped?
    }
    struct Saved: Decodable { var catalog: SettingsCatalog }
    guard let parsed = try? JSONDecoder().decode(State.self, from: Data(state.utf8)) else { return SettingsWorkspace() }
    var workspace = SettingsWorkspace(userId: parsed.userId, workspaceId: parsed.workspaceId, connected: parsed.connected)
    if let scoped = parsed.presence, scoped.workspaceId == parsed.workspaceId { workspace.presence = scoped.presence }
    workspace.catalog = (try? JSONDecoder().decode(Saved.self, from: Data(raw.utf8)))?.catalog ?? SettingsCatalog()
    return workspace
  }
}

enum SettingsText {
  static func statusHeader(_ section: inout LodyListSection, name: String, status: String) {
    guard status != "unknown" else {
      section.header = name
      return
    }
    section.header = "\(name) · \(String(localized: String.LocalizationValue("devices." + status), bundle: .lody))"
    section.headerStatus = status
  }

  static func option(_ id: String, _ title: String, symbol: String = "", selected: Bool) -> LodyListAction {
    var action = LodyListAction()
    action.id = id
    action.title = title
    action.symbol = symbol
    action.selected = selected
    return action
  }

  static func footer(_ id: String, _ text: String) -> LodyListSection {
    var section = LodyListSection()
    section.id = id
    section.footer = text
    return section
  }
}
