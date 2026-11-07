import Foundation

struct MemoryIdentity: Codable, Equatable, Sendable {
  var id: String
  var name: String
  var description: String?
  var role: String?
}

struct MemoryAssociation: Codable, Equatable, Sendable {
  var machineId: String
  var providerId: String
  var memoryId: String
  var name: String
  var description: String?
}

struct MemoryMachine: Codable, Equatable, Sendable {
  var id: String
  var name: String
}

struct MemorySnapshot: Codable, Equatable, Sendable {
  var machines: [MemoryMachine]
  var machineId: String?
  var entries: [MemoryAssociation]
  var identities: [MemoryIdentity]
  var status: String
  var cached: Bool
}

struct MemoryRequest: Encodable, Equatable, Sendable {
  var workspaceId: String
  var machineId: String?
  var action: String
  var memoryId: String?
  var base: MemoryAssociation?
}

typealias MemoryService = @MainActor (MemoryRequest) async throws -> MemorySnapshot

struct MemoryFailure: Equatable {
  var text: String
  var uncertain: Bool
  var status: String?

  static let statuses = ["not_installed", "not_running", "offline", "unknown", "unsupported", "error"]

  init(text: String, uncertain: Bool = false, status: String? = nil) {
    self.text = text
    self.uncertain = uncertain
    self.status = status
  }

  static func message(_ error: Error) -> String { "\(error) \((error as NSError).localizedDescription)" }

  init(_ error: Error) {
    let message = Self.message(error)
    if message.contains("forbidden") {
      self.init(text: MemorySections.text("forbidden"))
    } else if let status = Self.statuses.first(where: { message.contains("memory_\($0)") }) {
      self.init(text: MemorySections.status(status), status: status)
    } else if message.contains("memory_conflict") {
      self.init(text: String(localized: "settings.remote.conflict", bundle: .lody))
    } else {
      self.init(text: MemorySections.text("writeUnknown"), uncertain: true)
    }
  }
}

enum MemorySections {
  static let provider = "nowledge-mem"

  static func entryId(_ entry: MemoryAssociation) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    return (try? encoder.encode([entry.providerId, entry.memoryId])).map { String(decoding: $0, as: UTF8.self) } ?? ""
  }

  static func source(_ snapshot: MemorySnapshot) -> String {
    snapshot.machines.first { $0.id == snapshot.machineId }?.name ?? snapshot.machineId ?? ""
  }

  static func missing(_ snapshot: MemorySnapshot, _ item: MemoryAssociation) -> Bool {
    snapshot.status == "ready" && item.providerId == provider && !snapshot.identities.contains { $0.id == item.memoryId }
  }

  static func list(_ snapshot: MemorySnapshot?, loading: Bool, failed: Bool, uncertain: Bool) -> [LodyListSection] {
    guard let snapshot else { return [] }
    var machines = section("machines", header: text("source"), footer: text("ownOnly"))
    machines.rows = snapshot.machines.map { machine in
      var line = row("machine:\(machine.id)", machine.name, subtitle: machine.id)
      line.action = !loading
      line.selected = machine.id == snapshot.machineId
      return line
    }
    guard snapshot.machineId != nil else { return [machines] }
    var providerSection = section("provider", header: "Nowledge Mem", footer: text("contents"))
    providerSection.rows = [row("provider-status", status(snapshot.status), wrap: true)]
    if snapshot.status == "not_installed" {
      var install = row("provider-install", text("install"))
      install.action = true
      install.disclosure = true
      providerSection.rows.append(install)
    }
    var saved = section("saved", header: text("saved"), footer: snapshot.entries.isEmpty ? text("empty") : "")
    saved.rows = snapshot.entries.map { item in
      let subtitle = [source(snapshot), item.providerId, item.memoryId, item.description ?? "",
                      missing(snapshot, item) ? text("missing") : ""].filter { !$0.isEmpty }
      var line = row("saved:\(entryId(item))", item.name, subtitle: subtitle.joined(separator: " · "), wrap: true)
      line.action = true
      line.disclosure = true
      line.navigates = true
      return line
    }
    var sections = [machines, providerSection, saved]
    if snapshot.status == "ready" && !snapshot.cached {
      var available = section(
        "available", header: text("available"), footer: snapshot.identities.isEmpty ? text("noIdentities") : text("importHint")
      )
      available.rows = snapshot.identities.map { identity in
        let linked = snapshot.entries.contains { $0.providerId == provider && $0.memoryId == identity.id }
        let subtitle = [identity.id, identity.description ?? "", linked ? text("imported") : ""].filter { !$0.isEmpty }
        var line = row(
          "import:\(identity.id)", identity.name.isEmpty ? identity.id : identity.name,
          subtitle: subtitle.joined(separator: " · "), wrap: true
        )
        line.action = !linked && !loading && !failed && !uncertain
        return line
      }
      sections.append(available)
    }
    return sections
  }

  static func detail(_ item: MemoryAssociation, snapshot: MemorySnapshot, busy: Bool, uncertain: Bool) -> [LodyListSection] {
    var details = section("details", footer: text("contents"))
    let verified = item.providerId == provider
    details.rows = [
      row("memory-name", item.name, subtitle: item.description ?? "", wrap: true),
      row("memory-id", text("identity"), subtitle: item.memoryId, wrap: true),
      row("memory-source", source(snapshot), subtitle: item.machineId, wrap: true),
      row("memory-provider", text("provider"), subtitle: item.providerId),
      row(
        "memory-status", verified ? status(snapshot.status) : text("unverifiedProvider"),
        subtitle: missing(snapshot, item) ? text("missing") : "", wrap: true
      ),
    ]
    var remove = section("remove", footer: text("removeHint"))
    var button = row("memory-remove", text("remove"))
    button.destructive = true
    button.action = !busy && !uncertain && !snapshot.cached
    remove.rows = [button]
    return [details, remove]
  }

  static func warning(_ text: String, refresh: Bool) -> LodyListNotice {
    var notice = LodyListNotice()
    notice.symbol = "exclamationmark.triangle"
    notice.text = text
    notice.tint = "warning"
    if refresh {
      notice.actionLabel = String(localized: "settings.state.refresh", bundle: .lody)
      notice.actionSymbol = "arrow.clockwise"
    }
    return notice
  }

  static func cachedNotice() -> LodyListNotice {
    var notice = LodyListNotice()
    notice.symbol = "icloud.slash"
    notice.text = text("cached")
    notice.tint = "warning"
    return notice
  }

  static func status(_ value: String) -> String { String(localized: String.LocalizationValue("settings.memory.status." + value), bundle: .lody) }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.memory." + key), bundle: .lody) }

  private static func section(_ id: String, header: String = "", footer: String = "") -> LodyListSection {
    var section = LodyListSection()
    section.id = id
    section.header = header
    section.footer = footer
    return section
  }

  private static func row(_ id: String, _ title: String, subtitle: String = "", wrap: Bool = false) -> LodyListRow {
    var row = LodyListRow()
    row.id = id
    row.title = title
    row.subtitle = subtitle
    row.wrapSubtitle = wrap
    return row
  }
}
