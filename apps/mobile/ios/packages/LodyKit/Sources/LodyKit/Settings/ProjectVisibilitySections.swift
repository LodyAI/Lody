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
  /// The user's own machines; nil when the machine read failed (or a cache predates it).
  var ownedMachineIds: [String]?

  init(userId: String, rows: [VisibilityRow], ownedMachineIds: [String]? = nil) {
    self.userId = userId
    self.rows = rows
    self.ownedMachineIds = ownedMachineIds
  }

  /// Registrations plus, as desktop does, a private row for each catalog project on the user's
  /// own machine that has no registration yet.
  func effectiveRows(catalog: SettingsCatalog) -> [VisibilityRow] {
    guard let owned = ownedMachineIds.map({ Set($0) }), !owned.isEmpty else { return rows }
    var result = rows
    var keys = Set(rows.map(\.id))
    for project in catalog.projects where owned.contains(project.machineId) {
      guard let local = ProjectVisibilitySections.localId(project) else { continue }
      let row = VisibilityRow(machineId: project.machineId, localProjectId: local, ownerUserId: userId, sharedWithTeam: false, updatedAt: 0)
      if keys.insert(row.id).inserted { result.append(row) }
    }
    return result
  }

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

/// The request and the signed-in account the page already holds (so the list skips a session lookup).
typealias VisibilityService = @MainActor (VisibilityRequest, String) async throws -> VisibilitySnapshot

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
    let effective = snapshot?.effectiveRows(catalog: catalog) ?? []
    for item in effective {
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
    // The local catalog is the list's source. Before the first registration read, or when the
    // machine read failed, a project without a row shows as unknown and read only. Once the
    // user's machines are known, unregistered projects on others' machines stay hidden (desktop).
    let ownershipKnown = snapshot?.ownedMachineIds != nil
    for project in catalog.projects {
      guard let local = localId(project) else { continue }
      if effective.contains(where: { $0.machineId == project.machineId && $0.localProjectId == local }) { continue }
      if ownershipKnown { continue }
      var row = LodyListRow()
      row.id = "unknown:\(project.id)"
      row.title = project.name.isEmpty ? local : project.name
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

  /// The local project id of a catalog `<machine>:local:<id>` project.
  static func localId(_ project: SettingsProject) -> String? {
    let prefix = "\(project.machineId):local:"
    guard project.id.hasPrefix(prefix) else { return nil }
    return String(project.id.dropFirst(prefix.count))
  }

  private static func symbol(_ shared: Bool) -> String { shared ? "person.2" : "lock" }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.projects." + key), bundle: .lody) }
}
