import Foundation

struct RemoteSetting: Codable, Equatable, Sendable {
  var kind: String
  var id: String
  var name: String
  var machineId: String?
  var machineName: String?
  var readOnly: Bool?
  var detail: String?
  var prompt: String?
  var updatedAt: Double?

  var settingId: String { "setting:\(kind):\(machineId ?? ""):\(id)" }
  var locked: Bool { readOnly == true }
}

struct RemoteSettingEdit: Encodable, Equatable, Sendable {
  var item: RemoteSetting
  var name: String
  var prompt: String?
}

struct RemoteSettingsRequest: Encodable, Equatable, Sendable {
  var workspaceId: String
  var kind: String
  var edit: RemoteSettingEdit?
}

typealias RemoteSettingsService = @MainActor (RemoteSettingsRequest) async throws -> [RemoteSetting]

struct SavedRemoteSettings: Codable, Equatable, Sendable {
  var items: [RemoteSetting]
  var syncedAt: Double

  static func key(userId: String, workspaceId: String, kind: String) -> String {
    "remote-settings:\(userId):\(workspaceId):\(kind)"
  }

  static func parse(_ raw: String?, kind: String) -> SavedRemoteSettings? {
    guard let raw, let saved = try? JSONDecoder().decode(SavedRemoteSettings.self, from: Data(raw.utf8)),
          saved.syncedAt.isFinite, saved.items.allSatisfy({ $0.kind == kind }) else { return nil }
    return saved
  }

  var json: String {
    (try? JSONEncoder().encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "null"
  }
}

struct UsageWindow: Codable, Equatable, Sendable {
  var label: String?
  var usedPercent: Double
  var duration: Double?
  var resetsAt: Double?
}

struct AgentQuota: Codable, Equatable, Sendable {
  var id: String
  var provider: String
  var agentConfigId: String?
  var name: String?
  var windows: [UsageWindow]
}

struct AgentUsageConfig: Codable, Equatable, Sendable {
  var id: String
  var name: String
  var provider: String
  var eligible: Bool
  var rateLimitsAvailable: Bool?
}

struct AgentUsage: Codable, Equatable, Sendable {
  var configs: [AgentUsageConfig]
  var quotas: [AgentQuota]
}

enum RemoteSettingsFailure {
  static func message(_ error: Error, request: RemoteSettingsRequest) -> String {
    let described = "\(error) \((error as NSError).localizedDescription)"
    let mapping: [(String, String)] = [
      ("setting_read_only", "settings.remote.readOnly"),
      ("setting_conflict", "settings.remote.conflict"),
      ("setting_duplicate", "settings.remote.duplicate"),
    ]
    if let key = mapping.first(where: { described.contains($0.0) })?.1 { return String(localized: String.LocalizationValue(key), bundle: .lody) }
    let writing = request.edit != nil
    return String(localized: String.LocalizationValue(writing ? "settings.remote.saveFailed" : "settings.remote.loadFailed"), bundle: .lody)
  }
}

enum RemoteSettingsSections {
  private static let paceTolerance = 0.02
  private static let agentNames = ["claude": "Claude Code", "codex": "Codex", "kimi": "Kimi Code", "kimi-code": "Kimi Code",
                                   "opencode": "OpenCode"]

  static func agentName(_ type: String) -> String { agentNames[type] ?? type }

  static func agentIcon(_ type: String) -> String { LodyAgentIcon.asset(cliType: nil, agentType: type) ?? "" }

  static func machineState(_ presence: SettingsMachinePresence, _ id: String) -> String { presence.status(of: id) }

  static func usageSpan(_ ms: Double) -> String {
    let minutes = max(1, Int((ms / 60_000).rounded()))
    if minutes >= 1440 {
      let hours = Int((Double(minutes) / 60).rounded())
      return String.localizedStringWithFormat(String(localized: "settings.usage.spanDays", bundle: .lody), String(describing: hours / 24), String(describing: hours % 24))
    }
    if minutes >= 60 { return String.localizedStringWithFormat(String(localized: "settings.usage.spanHours", bundle: .lody), String(describing: minutes / 60), String(describing: minutes % 60)) }
    return String.localizedStringWithFormat(String(localized: "settings.usage.spanMinutes", bundle: .lody), String(describing: minutes))
  }

  private struct Pace {
    var pace: Double?
    var detail = ""
    var tone = ""
  }

  private static func pace(_ used: Double, _ duration: Double?, _ resetsAt: Double?, now: Double) -> Pace {
    guard let duration, duration != 0, let resetsAt, resetsAt != 0 else { return Pace() }
    let remaining = resetsAt * 1000 - now
    guard remaining > 0 else { return Pace() }
    let elapsed = min(1, max(0, 1 - remaining / (duration * 1000)))
    if used >= 1 { return Pace(pace: elapsed, detail: usage("exhausted"), tone: "warning") }
    if used - elapsed <= paceTolerance || elapsed <= 0 { return Pace(pace: elapsed, detail: usage("onPace")) }
    let elapsedMs = elapsed * duration * 1000
    let detail = String.localizedStringWithFormat(String(localized: "settings.usage.ahead", bundle: .lody), String(describing: Int(((used - elapsed) * 100).rounded())), String(describing: usageSpan((1 - used) * elapsedMs / used)))
    return Pace(pace: elapsed, detail: detail, tone: "warning")
  }

  private static func windowDuration(_ seconds: Double?) -> String {
    guard let seconds, seconds != 0 else { return usage("window") }
    if seconds.truncatingRemainder(dividingBy: 86400) == 0 {
      return String.localizedStringWithFormat(String(localized: "settings.usage.days", bundle: .lody), Int(seconds / 86400))
    }
    if seconds.truncatingRemainder(dividingBy: 3600) == 0 {
      return String.localizedStringWithFormat(String(localized: "settings.usage.hours", bundle: .lody), Int(seconds / 3600))
    }
    return String.localizedStringWithFormat(String(localized: "settings.usage.minutes", bundle: .lody), Int(seconds / 60))
  }

  private static func resetCaption(_ resetsAt: Double?, now: Double) -> String {
    guard let resetsAt, resetsAt != 0, resetsAt.isFinite, resetsAt * 1000 - now > 0 else { return usage("resetsUnknown") }
    return String.localizedStringWithFormat(String(localized: "settings.usage.resetsIn", bundle: .lody), String(describing: usageSpan(resetsAt * 1000 - now)))
  }

  static func rings(_ item: RemoteSetting, _ usage: AgentUsage?, now: Double) -> [LodyListVisualItem] {
    guard let usage, let config = usage.configs.first(where: { $0.id == item.id }), config.eligible else { return [] }
    if let detail = item.detail, !detail.isEmpty, detail != config.provider { return [] }
    return usage.quotas.filter { $0.provider == config.provider }.flatMap { quota in
      quota.windows.enumerated().map { index, window in
        let name = quota.name.flatMap { $0.isEmpty ? nil : $0 } ?? agentNames[config.provider] ?? config.provider
        let label = [name, windowDuration(window.duration), window.label ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        let used = min(1, max(0, window.usedPercent / 100))
        let value = String.localizedStringWithFormat(String(localized: "settings.usage.left", bundle: .lody), String(describing: Int(((1 - used) * 100).rounded())))
        let caption = resetCaption(window.resetsAt, now: now)
        let forecast = pace(used, window.duration, window.resetsAt, now: now)
        var ring = LodyListVisualItem()
        ring.id = "usage:\(item.machineId ?? ""):\(config.provider):\(quota.id):\(index)"
        ring.label = label
        ring.value = value
        ring.caption = caption
        ring.fraction = used
        ring.pace = forecast.pace
        ring.detail = forecast.detail
        ring.tone = forecast.tone
        ring.accessibilityLabel = [
          label, value, String.localizedStringWithFormat(String(localized: "settings.usage.used", bundle: .lody), String(describing: Int(window.usedPercent.rounded()))), caption, forecast.detail,
        ].filter { !$0.isEmpty }.joined(separator: ", ")
        return ring
      }
    }
  }

  static func make(
    kind: String, items: [RemoteSetting], failed: Bool, connected: Bool, agentUsage: [String: AgentUsage] = [:],
    presence: SettingsMachinePresence = .unknown, now: Double = LodyRelativeTime.now()
  ) -> [LodyListSection] {
    let shown = connected && !failed ? presence : .unknown
    if kind == "agent" { return agentSections(items, presence: shown, usage: agentUsage, now: now) }
    guard !items.isEmpty else { return [] }
    var section = LodyListSection()
    section.id = "settings"
    guard kind == "machine" else { return [] }
    section.footer = remote("machineFooter")
    section.rows = machineRows(items, presence: shown)
    return [section]
  }

  private static func base(_ item: RemoteSetting) -> LodyListRow {
    var row = LodyListRow()
    row.id = item.settingId
    row.title = item.name.isEmpty ? item.id : item.name
    row.disclosure = !item.locked
    row.action = !item.locked
    if item.locked {
      row.trailingSymbol = "lock"
      row.trailingSymbolLabel = remote("ownerOnly")
    }
    return row
  }

  private static func machineRows(_ items: [RemoteSetting], presence: SettingsMachinePresence) -> [LodyListRow] {
    var names: [String: Int] = [:]
    for item in items { names[item.name, default: 0] += 1 }
    return items.map { item in
      let state = machineState(presence, item.id)
      var row = base(item)
      row.subtitle = [String(localized: String.LocalizationValue("devices." + state), bundle: .lody), item.detail ?? "", (names[item.name] ?? 0) > 1 ? item.id : ""]
        .filter { !$0.isEmpty }.joined(separator: " · ")
      row.status = state
      row.image = "desktopcomputer"
      return row
    }
  }

  private static func agentFooter(_ state: String, rings: Bool) -> String {
    guard rings else { return state == "offline" ? usage("noneOffline") : "" }
    if state == "online" { return "\(usage("paceFooter"))\n\(usage("sharedShort"))" }
    if state == "offline" { return usage("lastOffline") }
    return usage("lastUnknown")
  }

  private static func agentSections(
    _ items: [RemoteSetting], presence: SettingsMachinePresence, usage: [String: AgentUsage], now: Double
  ) -> [LodyListSection] {
    var order: [String] = []
    var groups: [String: (section: LodyListSection, state: String, rings: [LodyListVisualItem], providers: Set<String>)] = [:]
    for item in items {
      let machine = item.machineId ?? item.machineName ?? ""
      if groups[machine] == nil {
        let state = machineState(presence, machine)
        var section = LodyListSection()
        section.id = "machine:\(machine)"
        let name = [item.machineName, item.machineId].compactMap { $0 }.first { !$0.isEmpty } ?? remote("machine")
        SettingsText.statusHeader(&section, name: name, status: state)
        groups[machine] = (section, state, [], [])
        order.append(machine)
      }
      var row = base(item)
      row.image = "sparkles"
      row.imageAsset = agentIcon(item.detail ?? "")
      groups[machine]?.section.rows.append(row)
      let reported = usage[item.machineId ?? ""]
      guard let config = reported?.configs.first(where: { $0.id == item.id }), config.eligible,
            groups[machine]?.providers.contains(config.provider) == false else { continue }
      let rings = self.rings(item, reported, now: now)
      guard !rings.isEmpty else { continue }
      groups[machine]?.providers.insert(config.provider)
      groups[machine]?.rings.append(contentsOf: rings)
    }
    return order.compactMap { groups[$0] }.map { group in
      var section = group.section
      section.footer = agentFooter(group.state, rings: !group.rings.isEmpty)
      if !group.rings.isEmpty {
        var visual = LodyListVisual()
        visual.type = "quotas"
        visual.dimmed = group.state != "online"
        visual.items = group.state == "online" ? group.rings : group.rings.map { ring in
          var copy = LodyListVisualItem()
          copy.id = ring.id
          copy.label = ring.label
          copy.value = ring.value
          copy.caption = ring.caption
          copy.fraction = ring.fraction
          copy.accessibilityLabel = ring.accessibilityLabel
          return copy
        }
        section.visual = visual
      }
      return section
    }
  }

  static func remote(_ key: String) -> String { String(localized: String.LocalizationValue("settings.remote." + key), bundle: .lody) }

  static func usage(_ key: String) -> String {
    String(localized: String.LocalizationValue("settings.usage." + key), bundle: .lody)
  }
}
