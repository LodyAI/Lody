import Foundation

struct VisibilityRow: Codable, Equatable, Sendable {
  var machineId: String
  var localProjectId: String
  var ownerUserId: String
  var sharedWithTeam: Bool
  var updatedAt: Double

  var id: String {
    "visibility:\(ProjectVisibilitySections.uriComponent(machineId)):\(ProjectVisibilitySections.uriComponent(localProjectId))"
  }
}

struct VisibilitySnapshot: Codable, Equatable, Sendable {
  var userId: String
  var rows: [VisibilityRow]

  var valid: Bool {
    !userId.isEmpty && rows.count <= 10000 && rows.allSatisfy {
      !$0.machineId.isEmpty && !$0.localProjectId.isEmpty && !$0.ownerUserId.isEmpty
        && $0.updatedAt.isFinite && $0.updatedAt >= 0
    }
  }
}

struct VisibilityRequest: Encodable, Equatable, Sendable {
  var page = "projects"
  var workspaceId: String
  var action: String
  var machineId: String?
  var localProjectId: String?
  var sharedWithTeam: Bool?

  static func list(_ workspaceId: String) -> VisibilityRequest {
    VisibilityRequest(workspaceId: workspaceId, action: "list")
  }

  static func set(_ workspaceId: String, row: VisibilityRow, shared: Bool) -> VisibilityRequest {
    VisibilityRequest(
      workspaceId: workspaceId, action: "set", machineId: row.machineId, localProjectId: row.localProjectId,
      sharedWithTeam: shared
    )
  }
}

typealias VisibilityService = @MainActor (VisibilityRequest) async throws -> VisibilitySnapshot

enum ProjectVisibilitySections {
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
  )

  static func uriComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
  }

  static func make(
    _ snapshot: VisibilitySnapshot?, catalog: SettingsCatalog, enabled: Bool,
    presence: SettingsMachinePresence = .unknown
  ) -> [LodyListSection] {
    var order: [String] = []
    var groups: [String: LodyListSection] = [:]
    func append(_ row: LodyListRow, to machine: String) {
      if groups[machine] == nil {
        var section = LodyListSection()
        section.id = machine
        SettingsText.statusHeader(
          &section, name: catalog.machineNames[machine].flatMap { $0.isEmpty ? nil : $0 } ?? machine,
          status: presence.status(of: machine)
        )
        groups[machine] = section
        order.append(machine)
      }
      groups[machine]?.rows.append(row)
    }
    for item in snapshot?.rows ?? [] {
      let project = catalog.projects.first { $0.id == "\(item.machineId):local:\(item.localProjectId)" }
      let owned = item.ownerUserId == snapshot?.userId
      let value = text(item.sharedWithTeam ? "sharedValue" : "private")
      var row = LodyListRow()
      row.id = item.id
      row.title = project.flatMap { $0.name.isEmpty ? nil : $0.name } ?? item.localProjectId
      row.subtitle = owned ? project?.rootPath ?? "" : text("othersOwner")
      row.subtitleMono = owned
      row.image = "folder"
      row.accessibilityValue = value
      row.value = value
      row.valueSymbol = symbol(item.sharedWithTeam)
      row.action = owned && enabled
      if owned {
        row.options = [
          SettingsText.option("shared", text("shared"), symbol: symbol(true), selected: item.sharedWithTeam),
          SettingsText.option("private", text("private"), symbol: symbol(false), selected: !item.sharedWithTeam),
        ]
      }
      append(row, to: item.machineId)
    }
    for project in catalog.projects {
      let prefix = "\(project.machineId):local:"
      guard project.id.hasPrefix(prefix) else { continue }
      let local = String(project.id.dropFirst(prefix.count))
      if snapshot?.rows.contains(where: { $0.machineId == project.machineId && $0.localProjectId == local }) == true { continue }
      var row = LodyListRow()
      row.id = "unknown:\(project.id)"
      row.title = project.name
      row.subtitle = project.rootPath
      row.subtitleMono = true
      row.image = "folder"
      row.value = text("unknownShort")
      row.valueSymbol = "questionmark.circle"
      row.accessibilityValue = text("unknown")
      append(row, to: project.machineId)
    }
    return order.compactMap { groups[$0] }
  }

  private static func symbol(_ shared: Bool) -> String { shared ? "person.2" : "lock" }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.projects." + key), bundle: .lody) }
}
