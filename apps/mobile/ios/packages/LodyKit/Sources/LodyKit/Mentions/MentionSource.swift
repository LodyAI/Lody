import LodyCore
import Foundation

typealias MentionCatalog = RuntimeContract.MentionCatalog
typealias MentionItem = RuntimeContract.MentionCatalogItemsItem

struct MentionSource: Codable, Equatable, Sendable {
  var workspaceId: String
  var sessionId: String?
  var projectId: String?
  var machineId: String?
  var agentConfigId: String?
  var cliType: String?
  var agentType: String?
}

@MainActor
struct MentionService {
  var load: @MainActor (MentionSource, String) async throws -> MentionCatalog

  static let live = MentionService { source, category in
    if let fixture = MentionFixture.response(payload(source, category)),
       let catalog = try? JSONDecoder().decode(MentionCatalog.self, from: Data(fixture.utf8)) {
      return catalog
    }
    guard let runtime = DataRuntime.current, runtime.workspace == source.workspaceId,
          let kind = RuntimeContract.MentionCatalogParamsCategory(rawValue: category) else {
      throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    return try await runtime.workspaceCall(RuntimeContract.Calls.MentionCatalog.self) { workspaceId, userId in
      RuntimeContract.MentionCatalogParams(
        workspaceId: workspaceId, userId: userId, category: kind, sessionId: source.sessionId, projectId: source.projectId,
        machineId: source.machineId, agentConfigId: source.agentConfigId, cliType: source.cliType, agentType: source.agentType
      )
    }
  }

  private static func payload(_ source: MentionSource, _ category: String) -> String {
    var object = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(source))) as? [String: Any] ?? [:]
    object["category"] = category
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    return String(decoding: data, as: UTF8.self)
  }
}

@MainActor
final class MentionCatalogStore {
  /// Load order: Agent Roles and the commands carrying prompt shortcuts first, as they list first.
  static let categories = ["role", "cmd", "file", "skill", "session", "issue", "pr"]

  let source: MentionSource
  /// The signed-in account; empty disables the workspace cache (a standalone picker page).
  let userId: String
  var changed: (() -> Void)?
  private let service: MentionService
  private var catalogs: [String: MentionCatalog] = [:]
  private var pending: [String: Task<MentionCatalog, Error>] = [:]
  private var failed: Set<String> = []
  /// Agent Roles and prompt shortcuts are workspace-wide, not tied to this composer's computer
  /// or agent, so the last accepted lists show at once while this composer reads its own.
  private var cached: [String: MentionCatalog] = [:]

  init(source: MentionSource, userId: String = "", service: MentionService = .live) {
    self.source = source
    self.userId = userId
    self.service = service
    for kind in MentionWorkspaceCache.kinds { cached[kind] = MentionWorkspaceCache.memory(kind, userId: userId, workspaceId: source.workspaceId) }
  }

  func catalog(_ category: String) -> MentionCatalog? { shown(category) }

  func preload() {
    restoreCache()
    for category in Self.categories { Task { _ = try? await load(category) } }
  }

  func load(_ category: String, refresh: Bool = false) async throws -> MentionCatalog {
    if !refresh, let task = pending[category] { return try await task.value }
    let task = Task { try await service.load(source, category) }
    pending[category] = task
    do {
      let value = try await task.value
      guard pending[category] == task else { return value }
      failed.remove(category)
      catalogs[category] = value
      remember(category, value)
      changed?()
      return value
    } catch {
      guard pending[category] == task else { throw error }
      pending[category] = nil
      failed.insert(category)
      changed?()
      throw error
    }
  }

  static func isShortcut(_ item: MentionItem) -> Bool {
    item.kind.rawValue == "cmd" && (item.insertText ?? "").hasPrefix("/shortcut:")
  }

  /// This composer's own read, else the workspace cache. Roles read while presence is not live
  /// come back empty and incomplete; the cached Roles stay until a complete read replaces them.
  private func shown(_ category: String) -> MentionCatalog? {
    switch category {
    case "role":
      if let live = catalogs["role"], !live.incomplete || !live.items.isEmpty { return live }
      return cached["role"] ?? catalogs["role"]
    case "cmd": return catalogs["cmd"] ?? cached["shortcut"]
    default: return catalogs[category]
    }
  }

  private func remember(_ category: String, _ value: MentionCatalog) {
    let entry: (kind: String, value: MentionCatalog)
    switch category {
    case "role":
      guard !value.incomplete else { return }
      entry = ("role", value)
    case "cmd":
      entry = ("shortcut", MentionCatalog(items: value.items.filter(Self.isShortcut), truncated: false, incomplete: false))
    default: return
    }
    cached[entry.kind] = entry.value
    MentionWorkspaceCache.write(entry.kind, entry.value, userId: userId, workspaceId: source.workspaceId)
  }

  /// A first composer after launch restores the persisted lists; an earlier one already left them in memory.
  private func restoreCache() {
    let missing = MentionWorkspaceCache.kinds.filter { cached[$0] == nil }
    guard !missing.isEmpty else { return }
    let userId = userId, workspaceId = source.workspaceId
    Task { [weak self] in
      for kind in missing {
        guard let value = await MentionWorkspaceCache.read(kind, userId: userId, workspaceId: workspaceId),
              let self, self.cached[kind] == nil else { continue }
        self.cached[kind] = value
        self.changed?()
      }
    }
  }

  func composerItemsJSON() -> String {
    // Prompt shortcuts arrive with the agent's commands (`cmd`) but list as their own category.
    let commands = shown("cmd")?.items ?? []
    let rows: [[String: Any]] = ChatMentionItem.categories.filter { category in
      switch category {
      case "file", "skill", "session": return true
      case "shortcut": return commands.contains(where: Self.isShortcut)
      case "cmd": return failed.contains(category) || commands.contains { !Self.isShortcut($0) }
      default: return failed.contains(category) || shown(category)?.items.isEmpty == false
      }
    }.map { category in
      [
        "path": category, "kind": "category", "subtitle": Self.notice(shown(category == "shortcut" ? "cmd" : category)),
        "name": String(localized: String.LocalizationValue("native.chat.mention." + (ChatMentionItem.labels[category] ?? category)), bundle: .lody),
      ]
    }
    // Typed matches follow the same category order: Roles, shortcuts, then the rest.
    let rank = { (item: MentionItem) -> Int in
      var category = item.kind.rawValue
      if category == "directory" { category = "file" }
      if Self.isShortcut(item) { category = "shortcut" }
      return ChatMentionItem.categories.firstIndex(of: category) ?? ChatMentionItem.categories.count
    }
    let ordered = Self.categories.compactMap { shown($0) }.flatMap(\.items).enumerated()
      .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
    let items = ordered.compactMap {
      (try? JSONSerialization.jsonObject(with: JSONEncoder().encode($0))) as? [String: Any]
    }
    let data = (try? JSONSerialization.data(withJSONObject: rows + items)) ?? Data("[]".utf8)
    return String(decoding: data, as: UTF8.self)
  }

  static func notice(_ catalog: MentionCatalog?) -> String {
    if catalog?.incomplete == true { return String(localized: "mentions.incomplete", bundle: .lody) }
    if catalog?.truncated == true { return String(localized: "mentions.truncated", bundle: .lody) }
    return ""
  }
}

/// The last accepted Agent Role and prompt shortcut mention lists, per account and workspace:
/// in memory for the next composer, and in a `SettingsSnapshotStore` across launches. Cached
/// rows only display; inserting one still sends a reference the runtime resolves at send.
@MainActor
enum MentionWorkspaceCache {
  static let kinds = ["role", "shortcut"]
  private static var values: [String: MentionCatalog] = [:]

  private static func store(_ kind: String, userId: String, workspaceId: String) -> SettingsSnapshotStore<MentionCatalog> {
    SettingsSnapshotStore(kind: "mention-" + kind, userId: userId, workspaceId: workspaceId)
  }

  static func memory(_ kind: String, userId: String, workspaceId: String) -> MentionCatalog? {
    let store = store(kind, userId: userId, workspaceId: workspaceId)
    return store.valid ? values[store.key] : nil
  }

  static func read(_ kind: String, userId: String, workspaceId: String) async -> MentionCatalog? {
    let store = store(kind, userId: userId, workspaceId: workspaceId)
    guard store.valid else { return nil }
    if let value = values[store.key] { return value }
    guard let value = await store.read() else { return nil }
    // A live read that landed meanwhile wins over the persisted list.
    if values[store.key] == nil { values[store.key] = value }
    return values[store.key]
  }

  static func write(_ kind: String, _ value: MentionCatalog, userId: String, workspaceId: String) {
    let store = store(kind, userId: userId, workspaceId: workspaceId)
    guard store.valid else { return }
    values[store.key] = value
    store.write(value)
  }
}
