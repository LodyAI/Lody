import Foundation

enum SettingsSections {
  static func make(_ state: SettingsState, developer: Bool, now: Double = LodyRelativeTime.now()) -> [LodyListSection] {
    let account = state.account
    let workspace = account == nil ? nil : state.workspace
    var sections = [
      section("account", rows: [accountRow(account)]),
      section("personal", header: text("section.personal"), rows: [
        row("preferences", text("preferences.title"), subtitle: text("preferences.subtitle"), image: "slider.horizontal.3"),
      ]),
    ]
    if account != nil {
      sections.append(remote(workspace, connection: state.connection, now: now))
    }
    sections.append(section("other", header: text("section.additional"), rows: [
      row("about", text("section.about"), subtitle: text("about.subtitle"), image: "info.circle"),
      row("diagnostics", String(localized: "diagnostics.title", bundle: .lody), image: "waveform.path.ecg"),
    ]))
    if developer {
      sections.append(section(
        "developer", header: text("section.developer"), footer: text("developer.footer"),
        rows: [row("debug-open", "Debug", image: "ladybug")]
      ))
    }
    return sections
  }

  private static func remote(_ workspace: AuthWorkspace?, connection: SettingsConnection, now: Double) -> LodyListSection {
    guard let workspace else {
      var unavailable = row(
        "workspace-unavailable", text("workspace.unavailable"), subtitle: text("workspace.unavailableHint"),
        image: "building.2", action: false, navigates: false
      )
      unavailable.wrapSubtitle = true
      unavailable.disclosure = false
      return section("remote", header: text("section.workspace"), rows: [unavailable])
    }
    var general = row("workspace-general", text("workspace.general"), subtitle: text("workspace.generalSubtitle"), image: "building.2")
    general.navigates = false
    var rows = [
      general,
      row("remote-agent", text("remote.agent"), image: "sparkles"),
      row("agent-roles", text("roles.title"), image: "person.crop.square"),
      row("prompt-shortcuts", text("shortcuts.title"), image: "doc.text"),
      row("project-visibility", text("projects.title"), image: "folder"),
    ]
    var github = row("github-settings", text("github.title"))
    github.imageAsset = "lody-mark-github"
    rows += [
      github,
      row("ai-usage", text("aiUsage.title"), image: "chart.bar.xaxis"),
    ]
    // Only trouble needs a footer; a live workspace stays quiet.
    var footer = ""
    if connection.state == "offline" {
      var resync = row("connection", text("connection.resync"), image: "arrow.clockwise")
      resync.disclosure = false
      resync.navigates = false
      rows.append(resync)
      footer = text("connection.offline")
      if connection.syncedAt != nil { footer += "\n\(text("connection.cached"))" }
    }
    return section(
      "remote", header: String.localizedStringWithFormat(String(localized: "settings.section.workspaceNamed", bundle: .lody), String(describing: workspace.name)), footer: footer, rows: rows
    )
  }

  private static func section(_ id: String, header: String = "", footer: String = "", rows: [LodyListRow]) -> LodyListSection {
    var section = LodyListSection()
    section.id = id
    section.header = header
    section.footer = footer
    section.rows = rows
    return section
  }

  private static func accountRow(_ account: AuthAccount?) -> LodyListRow {
    var result = row(
      "account", account?.user.name ?? text("account.welcome"), subtitle: account?.user.email ?? text("account.signInHint"),
      image: account?.user.image ?? "person.crop.circle", action: account != nil, navigates: account != nil
    )
    if let account, account.user.image?.isEmpty ?? true {
      result.image = ""
      result.monogram = String(account.user.name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    }
    if result.monogram.isEmpty, result.image.isEmpty { result.image = "person.crop.circle" }
    result.subtitleMono = account != nil
    return result
  }

  private static func row(
    _ id: String, _ title: String, subtitle: String = "", image: String = "", action: Bool = true, navigates: Bool = true
  ) -> LodyListRow {
    var row = LodyListRow()
    row.id = id
    row.title = title
    row.subtitle = subtitle
    row.image = image
    row.action = action
    row.disclosure = action
    row.navigates = navigates
    return row
  }

  static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue("settings." + key), bundle: .lody)
  }
}
