import Foundation

/// Presentation only: precise opened-by edges connect conversations; containment owns Tabs.
/// Missing precise openers never fall back to openedByRootSessionId.
enum SessionRelations {
  struct Row: Equatable {
    let session: SessionItem
    let tabs: [SessionItem]
    let depth: Int
    var sessions: [SessionItem] { [session] + tabs }
  }
  struct Branch {
    let depth: Int
    let continues: Bool
    let ancestors: [Int]
  }

  static func branch(at index: Int, rows: [Row]) -> Branch {
    let depths = rows.map { min(8, $0.depth) }
    let depth = depths[index]
    let following = depths.dropFirst(index + 1)
    func hasNext(at level: Int) -> Bool { following.first(where: { $0 <= level }) == level }
    let ancestors = depth > 1 ? (0..<(depth - 1)).filter { hasNext(at: $0 + 1) } : []
    return Branch(depth: depth, continues: depth > 0 && hasNext(at: depth), ancestors: ancestors)
  }

  struct Tree {
    let rows: [Row]
    var hasRelations: Bool { rows.count > 1 }
  }

  /// Explicit links keep the exact target (never the viewer's last visited Tab).
  static func target(_ id: String, sessions: [SessionItem]) -> String? {
    let indexed = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return target(id, indexed: indexed)
  }

  static func titles(sessions: [SessionItem]) -> [String: String] {
    let indexed = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return indexed.filter { target($0.key, indexed: indexed) != nil }.mapValues(\.title)
  }

  private static func target(_ id: String, indexed: [String: SessionItem]) -> String? {
    guard let session = indexed[id], !session.archived, session.childSessionPlacement != "side-panel" else { return nil }
    if let parent = session.parentSessionId {
      guard let root = indexed[parent], !root.archived, root.parentSessionId == nil,
        root.childSessionPlacement != "side-panel" else { return nil }
    }
    return id
  }

  static func tree(sessions: [SessionItem], current: String) -> Tree {
    let live = sessions.filter { !$0.archived && $0.childSessionPlacement != "side-panel" }
    let indexed = Dictionary(live.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    func root(_ id: String?) -> String? {
      guard let id, let item = indexed[id] else { return nil }
      if let parent = item.parentSessionId {
        guard let owner = indexed[parent], owner.parentSessionId == nil else { return nil }
        return parent
      }
      return id
    }
    guard var top = root(current) else { return Tree(rows: []) }
    var walked: Set<String> = [top]
    while let parent = root(indexed[top]?.openedBySessionId), walked.insert(parent).inserted { top = parent }
    let sorted = live.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    var tabs: [String: [SessionItem]] = [:]
    var children: [String: [SessionItem]] = [:]
    for item in sorted {
      if let parent = item.parentSessionId {
        if !item.isTabClosed || item.id == current { tabs[parent, default: []].append(item) }
      } else if let parent = root(item.openedBySessionId) {
        children[parent, default: []].append(item)
      }
    }
    var result: [Row] = []
    var built = Set<String>()
    var stack: [(String, Int)] = [(top, 0)]
    while let (id, depth) = stack.popLast() {
      guard built.insert(id).inserted, let item = indexed[id] else { continue }
      result.append(Row(session: item, tabs: tabs[id] ?? [], depth: depth))
      stack += (children[id] ?? []).reversed().map { ($0.id, depth + 1) }
    }
    return Tree(rows: result)
  }
}
