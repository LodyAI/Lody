import Foundation

// Display-only projection: credentials and launch environment values never belong in this list.
struct AgentProviderMachine: Codable, Equatable, Sendable {
  var id: String
  var name: String
  var online: Bool
  var readOnly: Bool
  var os: String?
  var supportsSetup: Bool = false
  var supportsCodexProfiles: Bool?
  var supportsAuthentication: Bool?
  var supportsPiExtensions: Bool?
}

struct AgentProviderItem: Codable, Equatable, Sendable {
  var id: String
  var machineId: String
  var name: String
  var cliType: String
  var agentType: String
  var prompt: String = ""
  var readOnly: Bool = false
  var command: String = ""
  var args: [String] = []
}

struct AgentProviderSetup: Codable, Equatable, Sendable {
  var id: String
  var machineId: String
  var name: String
  var agentType: String
  var status: String
  var attempt: Int = 0
  var failureCode: String?
  var canRetry: Bool = false
  var canDelete: Bool = false
}

struct AgentProviderCatalogItem: Codable, Equatable, Sendable {
  var id: String
  var name: String
  var cliType: String
  var agentType: String
  var presetId: String?
}

struct AgentProviderSnapshot: Codable, Equatable, Sendable {
  var machines: [AgentProviderMachine]
  var providers: [AgentProviderItem]
  var setups: [AgentProviderSetup]
  var catalog: [AgentProviderCatalogItem]
  var authRequired: Bool?
  var presets: [ProviderPreset]?
}

enum AgentProviderSections {
  static func merging(_ next: AgentProviderSnapshot, into previous: AgentProviderSnapshot?, machineID: String) -> AgentProviderSnapshot {
    let machines = Set(next.machines.map(\.id))
    var merged = next
    merged.providers = (previous?.providers ?? []).filter { $0.machineId != machineID && machines.contains($0.machineId) }
      + next.providers.filter { $0.machineId == machineID && machines.contains($0.machineId) }
    merged.setups = (previous?.setups ?? []).filter { $0.machineId != machineID && machines.contains($0.machineId) }
      + next.setups.filter { $0.machineId == machineID && machines.contains($0.machineId) }
    return merged
  }

  static func selected(_ snapshot: AgentProviderSnapshot, id: String?) -> AgentProviderMachine? {
    snapshot.machines.first { $0.id == id } ?? snapshot.machines.first
  }

  /// The selected computer's line, its providers (tap to open; long-press for actions) and, when
  /// the computer reports subscription windows, one usage bar per window. Adding lives in the bar's "+".
  static func make(_ snapshot: AgentProviderSnapshot, selectedID: String?, busy: Bool, usage: [String: AgentUsage] = [:], now: Double = Date().timeIntervalSince1970 * 1000) -> [LodyListSection] {
    guard let machine = selected(snapshot, id: selectedID) else { return [] }
    var computers = LodyListSection()
    computers.id = "provider-machine"
    var selector = machineRow(machine)
    selector.id = "provider-machine-picker"
    selector.action = snapshot.machines.count > 1
    selector.disclosure = snapshot.machines.count > 1
    computers.rows = [selector]

    var providers = LodyListSection()
    providers.id = "providers"
    providers.header = text("title")
    let locked = machine.readOnly
    providers.rows = snapshot.setups.filter { $0.machineId == machine.id }.map { setup in
      var row = LodyListRow()
      row.id = "provider-setup:\(setup.id)"
      row.title = setup.name
      row.imageAsset = LodyAgentIcon.asset(cliType: "builtin", agentType: setup.agentType) ?? ""
      row.image = "sparkles"
      row.subtitle = text("setup.\(setup.status)")
      row.wrapSubtitle = true
      let canAuthenticate = setup.status == "awaiting-auth" && machine.online && !locked && machine.supportsAuthentication == true
      if !busy {
        if canAuthenticate { row.menuActions.append(action("authenticate", "signIn", "person.crop.circle")) }
        if setup.canRetry { row.menuActions.append(action("retry", "retry", "arrow.clockwise")) }
        if setup.canDelete { row.menuActions.append(action("deleteSetup", "delete", "trash", destructive: true)) }
      }
      row.actions = row.menuActions
      row.action = !busy && (setup.canRetry || canAuthenticate)
      return row
    }
    let windows = usageWindows(snapshot, machine: machine, usage: usage, now: now)
    providers.rows += snapshot.providers.filter { $0.machineId == machine.id }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }.map { provider in
      var row = LodyListRow()
      row.id = "provider:\(provider.id)"
      row.title = provider.name.isEmpty ? RemoteSettingsSections.agentName(provider.agentType) : provider.name
      row.image = provider.cliType == "custom" ? "terminal" : "sparkles"
      row.imageAsset = LodyAgentIcon.asset(cliType: provider.cliType, agentType: provider.agentType) ?? ""
      row.subtitle = subtitle(provider, windows: windows[provider.id] ?? [])
      row.action = true
      row.disclosure = true
      row.navigates = true
      if !busy, !locked, !provider.readOnly {
        row.menuActions = [action("edit", "edit", "pencil")]
        if machine.online { row.menuActions.append(action("refresh", "refresh", "arrow.clockwise")) }
        row.menuActions.append(action("delete", "delete", "trash", destructive: true))
      }
      row.actions = row.menuActions
      return row
    }
    if locked {
      providers.footer = text("ownerOnlyFooter")
    } else if !machine.online {
      providers.footer = text("offline")
    }
    if providers.rows.isEmpty {
      var empty = LodyListRow()
      empty.id = "providers-empty"
      empty.title = text(locked || !machine.online ? "empty" : "emptyAdd")
      empty.wrapSubtitle = true
      providers.rows = [empty]
    }
    var sections = [computers, providers]
    let bars = windows.values.flatMap { $0 }.sorted { $0.id < $1.id }
    if !bars.isEmpty {
      var usageSection = LodyListSection()
      usageSection.id = "provider-usage"
      usageSection.header = text("usage")
      usageSection.footer = machine.online ? RemoteSettingsSections.usage("sharedShort") : RemoteSettingsSections.usage("lastOffline")
      usageSection.rows = bars.map { ring in
        var row = LodyListRow()
        row.id = ring.id
        row.title = ring.label
        row.value = ring.value
        row.subtitle = [ring.caption, ring.detail].filter { !$0.isEmpty }.joined(separator: " · ")
        row.progress = max(0, 1 - ring.fraction)
        return row
      }
      sections.append(usageSection)
    }
    return sections
  }

  /// Subscription windows per provider id, as the shared usage projection reports them.
  static func usageWindows(_ snapshot: AgentProviderSnapshot, machine: AgentProviderMachine, usage: [String: AgentUsage], now: Double) -> [String: [LodyListVisualItem]] {
    guard let reported = usage[machine.id] else { return [:] }
    var seen: Set<String> = []
    var result: [String: [LodyListVisualItem]] = [:]
    for provider in snapshot.providers where provider.machineId == machine.id {
      let item = RemoteSetting(kind: "agent", id: provider.id, name: provider.name, machineId: machine.id, detail: provider.agentType)
      let rings = RemoteSettingsSections.rings(item, reported, now: now).filter { seen.insert($0.id).inserted }
      guard !rings.isEmpty else { continue }
      result[provider.id] = rings
    }
    return result
  }

  private static func subtitle(_ provider: AgentProviderItem, windows: [LodyListVisualItem]) -> String {
    var parts: [String] = []
    if provider.cliType == "custom" {
      parts.append(provider.command.isEmpty ? text("custom") : provider.command)
    } else {
      let kind = RemoteSettingsSections.agentName(provider.agentType)
      if kind != provider.name { parts.append(kind) }
      if provider.cliType == "registry" { parts.append(text("registry")) }
    }
    if let tightest = windows.min(by: { $0.fraction > $1.fraction }) { parts.append(tightest.value) }
    return parts.joined(separator: " · ")
  }

  static func picker(_ machines: [AgentProviderMachine], selectedID: String?) -> [LodyListSection] {
    var section = LodyListSection()
    section.id = "machines"
    section.rows = machines.map { machine in
      var row = machineRow(machine)
      row.id = "provider-machine:\(machine.id)"
      row.action = true
      row.selected = machine.id == selectedID
      return row
    }
    return [section]
  }

  private static func machineRow(_ machine: AgentProviderMachine) -> LodyListRow {
    var row = LodyListRow()
    row.title = machine.name.isEmpty ? machine.id : machine.name
    row.image = machineSymbol(machine)
    row.status = machine.online ? "online" : "offline"
    let state = String(localized: String.LocalizationValue("devices." + row.status), bundle: .lody)
    row.subtitle = [state, text(machine.readOnly ? "teammateMachine" : "ownMachine")].joined(separator: " · ")
    return row
  }

  static func machineSymbol(_ machine: AgentProviderMachine) -> String {
    let os = (machine.os ?? "").lowercased()
    if os.contains("win") { return "pc" }
    if os.contains("linux") { return "server.rack" }
    let name = machine.name.lowercased()
    if name.contains("macbook") { return "laptopcomputer" }
    if name.contains("imac") { return "desktopcomputer" }
    if name.contains("mini") { return "macmini" }
    return "desktopcomputer"
  }

  private static func action(_ id: String, _ title: String, _ symbol: String, destructive: Bool = false) -> LodyListAction {
    LodyListAction(id: id, title: text(title), symbol: symbol, destructive: destructive)
  }

  static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue("settings.providers." + key), bundle: .lody)
  }
}

struct ProviderPreset: Codable, Equatable, Sendable {
  struct Endpoint: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var url: String
  }
  struct Mode: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var endpoint: String?
    var tokenPrefix: String?
    var customEndpoint: Bool
    var endpoints: [Endpoint]
  }
  var id: String
  var name: String
  var cliType: String
  var agentType: String
  var tokenEnvKey: String
  var protectedEnvKeys: [String]
  var modes: [Mode]
}

