import Foundation
import LodyCore

@MainActor
struct ItemDetailService {
  var load: (RuntimeContract.ItemDetailParams) async throws -> RuntimeContract.ItemDetail
  // Observe the session owner's projection without opening another runtime session.
  var observe: (@escaping @MainActor (Int, String?) -> Void) -> (() -> Void)
}

@MainActor
final class ItemDetailStore {
  struct Item {
    var detail: RuntimeContract.ItemDetail?
    var loading = false
    var error: String?
    var cursor: String?
    var request = UUID()
  }

  let itemIds: [String]
  private(set) var items: [String: Item] = [:]
  var changed: (() -> Void)?
  private let sessionId: String
  private let entryId: String
  private let service: ItemDetailService
  private var generation: Int
  private var revision = -1
  private var expected: [String: Int] = [:]
  private var waiting = false
  private var tasks: [String: Task<Void, Never>] = [:]
  private var unobserve: (() -> Void)?

  init(sessionId: String, entryId: String, itemIds: [String], generation: Int, service: ItemDetailService) {
    precondition(!itemIds.isEmpty && Set(itemIds).count == itemIds.count)
    self.sessionId = sessionId
    self.entryId = entryId
    self.itemIds = itemIds
    self.generation = generation
    self.service = service
  }

  func start() {
    guard unobserve == nil else { return }
    unobserve = service.observe { [weak self] generation, json in self?.receive(generation: generation, json: json) }
    for id in itemIds { load(id) }
  }

  func finish() {
    unobserve?()
    unobserve = nil
    invalidate()
  }

  private func invalidate() {
    for task in tasks.values { task.cancel() }
    tasks.removeAll()
    items.removeAll()
  }

  func retry(_ id: String) { load(id, cursor: items[id]?.cursor) }

  func loadMore(_ id: String) {
    guard let detail = items[id]?.detail, detail.truncated else { return }
    load(id, cursor: detail.nextCursor)
  }

  private func load(_ id: String, cursor: String? = nil) {
    tasks[id]?.cancel()
    let token = UUID()
    var item = items[id] ?? Item()
    item.loading = true
    item.error = nil
    item.cursor = cursor
    item.request = token
    items[id] = item
    changed?()
    let load = service.load
    let params = RuntimeContract.ItemDetailParams(sessionId: sessionId, entryId: entryId, itemId: id, cursor: cursor)
    tasks[id] = Task { [weak self] in
      do {
        var page = try await load(params)
        guard let self, items[id]?.request == token else { return }
        guard page.itemId == id else { throw DetailError("Item detail returned a different item ID") }
        guard !page.truncated || (page.nextCursor?.isEmpty == false && page.nextCursor != cursor) else {
          throw DetailError("Truncated item detail requires a new cursor")
        }
        if let expected = expected[id], page.rev < expected { throw DetailError("Item detail revision is behind the session") }
        if cursor != nil {
          guard let previous = items[id]?.detail, previous.rev == page.rev else {
            // A new version cannot be appended to a previous version's blocks.
            self.load(id)
            return
          }
          page.blocks = previous.blocks + page.blocks
          page.rawInput = page.rawInput ?? previous.rawInput
          page.rawOutput = page.rawOutput ?? previous.rawOutput
        }
        items[id]?.detail = page
        items[id]?.loading = false
        tasks[id] = nil
        changed?()
      } catch {
        guard let self, items[id]?.request == token else { return }
        items[id]?.error = error.localizedDescription
        items[id]?.loading = false
        tasks[id] = nil
        changed?()
      }
    }
  }

  private func receive(generation incoming: Int, json: String?) {
    guard incoming >= generation else { return }
    if incoming > generation {
      invalidate()
      expected.removeAll()
      waiting = true
      generation = incoming
      revision = -1
      changed?()
    }
    guard let json else { return }
    do {
      let envelope = try JSONDecoder().decode(Projection.self, from: Data(json.utf8))
      guard envelope.v == 1 else { throw DetailError("Unsupported session projection version") }
      guard envelope.revision > revision else { return }
      revision = envelope.revision
      guard envelope.status == "live" else { changed?(); return }
      let resuming = waiting
      waiting = false
      let entry = envelope.entries.first { $0.id == entryId }
      let projected = (entry?.items ?? []).flatMap { [$0] + ($0.run?.items ?? []) }
      for id in itemIds {
        if let item = projected.first(where: { $0.itemId == id }) {
          let previous = expected[id] ?? items[id]?.detail?.rev
          expected[id] = item.rev
          if !resuming, item.rev > (previous ?? -1) { load(id) }
        }
        if resuming { load(id) }
      }
    } catch {
      for id in itemIds { items[id, default: Item()].error = error.localizedDescription }
      changed?()
    }
  }

  private struct Projection: Decodable {
    var v: Int
    var revision: Int
    var status: String
    var entries: [Entry]
    struct Entry: Decodable { var id: String; var items: [ProjectedItem] }
    struct ProjectedItem: Decodable {
      var itemId: String
      var rev: Int
      var run: Run?
      struct Run: Decodable { var items: [ProjectedItem]? }
    }
  }

  private struct DetailError: LocalizedError {
    var message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
  }
}
