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

  static func make(_ snapshot: AgentProviderSnapshot, selectedID: String?, busy: Bool, usage: [String: AgentUsage] = [:], now: Double = Date().timeIntervalSince1970 * 1000) -> [LodyListSection] {
    guard let machine = selected(snapshot, id: selectedID) else { return [] }
    var computers = LodyListSection()
    computers.id = "provider-machine"
    var selector = machineRow(machine)
    selector.id = "provider-machine-picker"
    selector.action = true
    selector.disclosure = true
    computers.rows = [selector]

    var providers = LodyListSection()
    providers.id = "providers"
    providers.header = text("title")
    providers.rows = snapshot.setups.filter { $0.machineId == machine.id }.map { setup in
      var row = LodyListRow()
      row.id = "provider-setup:\(setup.id)"
      row.title = setup.name
      row.imageAsset = LodyAgentIcon.asset(cliType: "builtin", agentType: setup.agentType) ?? ""
      row.image = "sparkles"
      row.subtitle = text("setup.\(setup.status)")
      row.wrapSubtitle = true
      let canAuthenticate = setup.status == "awaiting-auth" && machine.online && !machine.readOnly && machine.supportsAuthentication == true
      if !busy {
        if canAuthenticate { row.menuActions.append(action("authenticate", "signIn", "person.crop.circle")) }
        if setup.canRetry { row.menuActions.append(action("retry", "retry", "arrow.clockwise")) }
        if setup.canDelete { row.menuActions.append(action("deleteSetup", "delete", "trash", destructive: true)) }
      }
      row.actions = row.menuActions
      row.action = !busy && (setup.canRetry || canAuthenticate)
      return row
    }
    providers.rows += snapshot.providers.filter { $0.machineId == machine.id }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }.map { provider in
      var row = LodyListRow()
      row.id = "provider:\(provider.id)"
      row.title = provider.name
      row.image = provider.cliType == "custom" ? "terminal" : "sparkles"
      row.imageAsset = LodyAgentIcon.asset(cliType: provider.cliType, agentType: provider.agentType) ?? ""
      var detail: [String] = []
      if provider.cliType != "builtin" { detail.append(text(provider.cliType == "custom" ? "custom" : "registry")) }
      if provider.cliType == "custom" { detail.append(provider.command) }
      row.subtitle = detail.joined(separator: " · ")
      row.action = !busy
      row.disclosure = true
      if provider.readOnly || machine.readOnly {
        row.trailingSymbol = "lock"
        row.trailingSymbolLabel = RemoteSettingsSections.remote("ownerOnly")
      } else if !busy {
        row.menuActions = [action("edit", "edit", "pencil")]
        if machine.online { row.menuActions.append(action("refresh", "refresh", "arrow.clockwise")) }
        row.menuActions.append(action("delete", "delete", "trash", destructive: true))
      }
      row.actions = row.menuActions
      return row
    }
    if providers.rows.isEmpty {
      var empty = LodyListRow()
      empty.id = "providers-empty"
      empty.title = text("empty")
      providers.rows = [empty]
    }
    if !machine.readOnly {
      var add = LodyListRow()
      add.id = "provider-add"
      add.title = text("add")
      add.image = "plus"
      add.action = !busy && machine.online
      providers.rows.append(add)
    }
    let items = snapshot.providers.filter { $0.machineId == machine.id }.map {
      RemoteSetting(kind: "agent", id: $0.id, name: $0.name, machineId: $0.machineId, detail: $0.agentType)
    }
    let presence = SettingsMachinePresence(state: busy ? "unknown" : "live", onlineMachineIds: machine.online ? [machine.id] : [])
    if let usageSection = RemoteSettingsSections.make(kind: "agent", items: items, failed: false, connected: !busy,
                                                     agentUsage: usage, presence: presence, now: now).first {
      providers.visual = usageSection.visual
      providers.footer = usageSection.footer
    }
    if !machine.online { providers.footer = text("offline") }
    return [computers, providers]
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
    row.image = "desktopcomputer"
    row.status = machine.online ? "online" : "offline"
    row.subtitle = String(localized: String.LocalizationValue("devices." + row.status), bundle: .lody)

    return row
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

