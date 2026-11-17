import Foundation
import LodyCore

/// Settings › Projects' Project groups (web Settings › Projects multi-repository rows) and the
/// read-only group page. Mobile does not create or edit groups yet; desktop does.
enum ProjectGroupSections {
  typealias Group = RuntimeContract.ProjectGroupItem

  static let rowPrefix = "projectGroup:"

  /// One row per group, by name: how many repositories or folders, and where it runs.
  static func section(_ groups: [Group], machineNames: [String: String]) -> LodyListSection? {
    guard !groups.isEmpty else { return nil }
    let rows = groups.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }.map { group in
      var row = LodyListRow.item(
        rowPrefix + group.id, group.name.isEmpty ? text("untitled") : group.name,
        subtitle: [members(group.members.count), place(group, machineNames: machineNames)].joined(separator: " · "),
        imageAsset: "lody.icon.projectGroup", disclosure: true, navigates: true
      )
      row.accessibilityValue = row.subtitle
      return row
    }
    return .group("projectGroups", header: text("header"), rows)
  }

  /// The group page: where it runs and who created it, then every member in placement order.
  static func detail(_ group: Group, userId: String, owner: String?, machineNames: [String: String]) -> [LodyListSection] {
    let creator = group.ownerUserId == userId ? text("ownerYou") : (owner ?? text("ownerMember"))
    let info: [LodyListRow] = [
      .item("computer", text("computer"), value: place(group, machineNames: machineNames), action: false),
      .item("owner", text("owner"), value: creator, action: false),
    ]
    let rows = group.members.map { member -> LodyListRow in
      let local = member.kind == .local
      let machine = member.machineId.map { machineNames[$0] ?? $0 } ?? ""
      var row = LodyListRow.item(
        "member:" + member.id, member.label,
        subtitle: [member.path, local ? machine : ""].filter { !$0.isEmpty }.joined(separator: " · "),
        image: local ? "folder" : "", imageAsset: local ? "" : "lody-mark-github", action: false, subtitleMono: true
      )
      if let repository = member.repoFullName { row.repository = repository }
      return row
    }
    return [
      .group("info", info),
      .group("members", header: members(group.members.count), footer: text("readOnly"), rows),
    ]
  }

  /// The computer its local members pin, any computer, or none when they are split across two.
  static func place(_ group: Group, machineNames: [String: String]) -> String {
    if group.conflict { return text("conflict") }
    guard let machine = group.machineId, !machine.isEmpty else { return text("anyComputer") }
    return machineNames[machine].flatMap { $0.isEmpty ? nil : $0 } ?? machine
  }

  static func members(_ count: Int) -> String {
    String.localizedStringWithFormat(String(localized: "project.group.members", bundle: .lody), count)
  }

  static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue("settings.projectGroups." + key), bundle: .lody)
  }
}
