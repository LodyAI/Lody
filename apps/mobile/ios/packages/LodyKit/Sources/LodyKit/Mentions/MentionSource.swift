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
  static let categories = ["file", "skill", "session", "role", "issue", "pr", "cmd"]

  let source: MentionSource
  var changed: (() -> Void)?
  private let service: MentionService
  private var catalogs: [String: MentionCatalog] = [:]
  private var pending: [String: Task<MentionCatalog, Error>] = [:]
  private var failed: Set<String> = []

  init(source: MentionSource, service: MentionService = .live) {
    self.source = source
    self.service = service
  }

  func catalog(_ category: String) -> MentionCatalog? { catalogs[category] }

  func preload() {
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

  func composerItemsJSON() -> String {
    // Prompt shortcuts arrive with the agent's commands (`cmd`) but list as their own category.
    let commands = catalogs["cmd"]?.items ?? []
    let isShortcut = { (item: MentionItem) in item.kind.rawValue == "cmd" && (item.insertText ?? "").hasPrefix("/shortcut:") }
    let rows: [[String: Any]] = ChatMentionItem.categories.filter { category in
      switch category {
      case "file", "skill", "session": return true
      case "shortcut": return commands.contains(where: isShortcut)
      case "cmd": return failed.contains(category) || commands.contains { !isShortcut($0) }
      default: return failed.contains(category) || catalogs[category]?.items.isEmpty == false
      }
    }.map { category in
      [
        "path": category, "kind": "category", "subtitle": Self.notice(catalogs[category == "shortcut" ? "cmd" : category]),
        "name": String(localized: String.LocalizationValue("native.chat.mention." + (ChatMentionItem.labels[category] ?? category)), bundle: .lody),
      ]
    }
    let items = Self.categories.compactMap { catalogs[$0] }.flatMap(\.items).compactMap {
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
