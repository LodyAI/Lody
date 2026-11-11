import Foundation

enum SessionState: String, Sendable {
  case live, attention, failed, idle, done, archived

  private static let statuses: [String: SessionState] = [
    "running": .live, "initializing": .live, "processing": .live, "in_progress": .live, "queued": .live,
    "requestPermission": .attention, "waiting": .attention, "error": .failed, "idle": .idle, "pending": .idle,
    "completed": .done,
  ]
  private static let tints: [SessionState: String] = [
    .live: "blue", .attention: "warning", .failed: "danger", .archived: "tertiary", .idle: "secondary", .done: "secondary",
  ]

  init(_ session: SessionItem) {
    if session.archived {
      self = .archived
      return
    }
    let state = Self.statuses[session.status] ?? .idle
    self = session.awaitingUserSince != nil && state != .live ? .attention : state
  }

  var tint: String { Self.tints[self] ?? "" }

  var badge: String {
    guard [.attention, .failed, .archived].contains(self) else { return "" }
    return String(localized: String.LocalizationValue("inbox.badge." + rawValue), bundle: .lody)
  }
}

enum SessionRows {
  typealias Family = (session: SessionItem, children: [SessionItem])

  static func isChat(_ projectId: String) -> Bool { projectId.hasSuffix(":unassigned") }

  static func isUnread(_ session: SessionItem) -> Bool {
    guard let message = session.lastMessageAt else { return false }
    return !session.isTabClosed && (session.lastReadAt.map { message > $0 } ?? true)
  }

  static func needsEmphasis(_ session: SessionItem) -> Bool {
    guard isUnread(session), let message = session.lastMessageAt else { return false }
    return session.lastViewedMessageAt.map { message > $0 } ?? true
  }

  static func byActivity(_ left: SessionItem, _ right: SessionItem) -> Bool {
    if left.pinned != right.pinned { return left.pinned }
    return left.activityAt > right.activityAt
  }

  static func projectId(ofRow id: String) -> String? {
    let sections = ["chat", "toggle:chat", "view:chat", "project:chat", "pinned", "toggle:pinned"]
    guard !sections.contains(id), !id.hasPrefix("view:") else { return nil }
    if id.hasPrefix("toggle:") { return String(id.dropFirst(7)) }
    if id.hasPrefix("project:") { return String(id.dropFirst(8)) }
    return nil
  }

  static func row(_ session: SessionItem, projectName: String = "", now: Double = LodyRelativeTime.now()) -> LodyListRow {
    let state = SessionState(session)
    var row = LodyListRow()
    row.id = session.id
    row.title = session.title
    row.subtitle = [projectName, session.branchName ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    row.subtitleMono = !(session.branchName ?? "").isEmpty
    row.modelName = session.modelNeverRan ? String(localized: "session.notRun", bundle: .lody) : session.modelName ?? ""
    row.diff = session.diff
    row.value = LodyRelativeTime.compact(session.activityAt, now: now)
    row.accessibilityValue = LodyRelativeTime.text(session.activityAt, now: now)
    row.unread = needsEmphasis(session)
    row.pinned = session.pinned
    row.badge = state.badge
    if [.live, .attention, .failed].contains(state) { row.imageTint = state.tint }
    row.action = true
    row.navigates = true
    row.actions = trailingActions(session)
    // Archived chats only offer unarchive on the swipe; pinning waits until they return.
    row.leadingActions = session.archived ? [] : [pin(session.pinned)]
    row.menuActions = session.archived
      ? [archive(true), share(), delete()]
      : [rename(), pin(session.pinned), archive(false), share(), delete()]
    row.preview = "session"
    row.branch = session.branchName ?? ""
    row.prStatus = session.pullRequests.last?.status ?? ""
    row.prCI = PullRequestCI(session.pullRequests.last?.ci)?.rawValue ?? ""
    return row
  }

  struct ListAttention {
    var state: SessionState
    var unread: Bool
    var emphasis: Bool

    init(_ session: SessionItem) {
      state = SessionState(session)
      unread = isUnread(session)
      emphasis = needsEmphasis(session)
    }
  }

  /// Display-only summary. Closed Tabs suppress unread, but may still have running work.
  static func conversationAttention(_ sessions: [SessionItem]) -> [String: ListAttention] {
    let indexed = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return conversationAttention(sessions, indexed: indexed)
  }

  static func conversationAttention(_ sessions: [SessionItem], indexed: [String: SessionItem]) -> [String: ListAttention] {
    var result = Dictionary(sessions.filter { !isTab($0) }.map { ($0.id, ListAttention($0)) }, uniquingKeysWith: { first, _ in first })
    let priority: [SessionState] = [.failed, .attention, .live]
    for tab in sessions where isTab(tab) && !tab.archived && tab.childSessionPlacement != "side-panel" {
      let id = DirectoryTabs.root(tab, indexed: indexed)
      guard let owner = indexed[id], !isTab(owner), !owner.archived, owner.machineId == tab.machineId,
        var summary = result[id] else { continue }
      let state = SessionState(tab)
      if let rank = priority.firstIndex(of: state), rank < (priority.firstIndex(of: summary.state) ?? priority.count) {
        summary.state = state
      }
      summary.unread = summary.unread || isUnread(tab)
      summary.emphasis = summary.emphasis || needsEmphasis(tab)
      result[id] = summary
    }
    return result
  }

  static func treeRows(
    _ sessions: [SessionItem], all: [SessionItem], maxRoots: Int = .max, row: (SessionItem) -> LodyListRow
  ) -> [LodyListRow] {
    let indexed = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return treeRows(tree(sessions, indexed: indexed), attention: conversationAttention(all, indexed: indexed), maxRoots: maxRoots, row: row)
  }

  /// Render already partitioned families without rebuilding catalog-wide projections per section.
  static func treeRows(
    _ families: [Family], attention: [String: ListAttention], maxRoots: Int = .max, row: (SessionItem) -> LodyListRow
  ) -> [LodyListRow] {
    func displayRow(_ session: SessionItem) -> LodyListRow {
      var result = row(session)
      if let summary = attention[session.id], !session.archived {
        result.badge = summary.state.badge
        result.imageTint = [.live, .attention, .failed].contains(summary.state) ? summary.state.tint : ""
        result.unread = summary.emphasis
      }
      return result
    }
    return families.prefix(maxRoots).flatMap { group -> [LodyListRow] in
      var parent = displayRow(group.session)
      guard !group.children.isEmpty else { return [parent] }
      let members = group.children
      let urgent = [SessionState.attention, .failed, .live].lazy.compactMap { state in
        members.first { (attention[$0.id]?.state ?? SessionState($0)) == state }
      }.first
      let status = displayRow(urgent ?? group.children[0])
      parent.treeParent = true
      parent.childCount = group.children.count
      parent.collapsedValue = String.localizedStringWithFormat(String(localized: "inbox.session.children", bundle: .lody), group.children.count)
      parent.collapsedBadge = status.badge
      parent.collapsedImageTint = status.imageTint
      return [parent] + group.children.enumerated().map { index, child in
        var item = displayRow(child)
        item.parentId = group.session.id
        item.lastChild = index == group.children.count - 1
        // A child almost always shares its opener's project: show it only when it differs.
        if item.place == parent.place { item.place = "" }
        return item
      }
    }
  }

  /// A Tab or side chat (`parentSessionId`) belongs to its parent conversation, not the list
  /// (web `sessionListAtom` drops them from the sidebar entirely).
  static func isTab(_ session: SessionItem) -> Bool { !(session.parentSessionId ?? "").isEmpty }

  // Input order is the list's ranking; a group takes its freshest member's place.
  // Only opened chats nest under their opener (web `buildOpenedBySessionTree`); Tabs never list.
  static func tree(_ sessions: [SessionItem], all: [SessionItem]) -> [Family] {
    tree(sessions, indexed: Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }))
  }

  static func tree(_ sessions: [SessionItem], indexed: [String: SessionItem]) -> [Family] {
    let sessions = sessions.filter { !isTab($0) }
    let visible = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    /// The listed conversation an id stands for: a Tab resolves to the conversation it belongs to.
    func conversation(_ id: String) -> String {
      var current = id
      var seen: Set = [id]
      while let parent = indexed[current]?.parentSessionId, !parent.isEmpty, seen.insert(parent).inserted { current = parent }
      return current
    }
    func parent(of session: SessionItem) -> String? {
      // Opened chats join their opener's family, even across projects/computers; one opened from
      // inside a Tab joins that Tab's conversation.
      let candidates = [session.openedBySessionId, session.openedByRootSessionId]
      return candidates.compactMap { $0 }.map(conversation).first { id in
        id != session.id && visible[id]?.archived == session.archived
      }
    }
    func root(of session: SessionItem) -> String {
      var seen: Set = [session.id]
      var current = session
      while let id = parent(of: current) {
        if seen.contains(id) { return session.id }
        seen.insert(id)
        guard let next = visible[id] else { break }
        current = next
      }
      return current.id
    }
    var order: [String] = []
    var groups: [String: (session: SessionItem, children: [SessionItem])] = [:]
    for session in sessions {
      let id = root(of: session)
      if groups[id] == nil, let head = visible[id] {
        groups[id] = (head, [])
        order.append(id)
      }
      if id != session.id { groups[id]?.children.append(session) }
    }
    return order.compactMap { groups[$0] }
  }

  static func deletionTargets(_ sessions: [SessionItem], id: String) -> [SessionItem] {
    sessions.filter { $0.id == id || $0.parentSessionId == id }
  }

  static func deletionBlocked(_ sessions: [SessionItem]) -> Bool {
    sessions.contains { !$0.archived && !["idle", "pending", "completed", "error"].contains($0.status) }
  }

  static func projectMenu(_ project: SessionProject) -> [LodyListAction] {
    var actions = [action("open", "project.action.open", "folder")]
    if !isChat(project.id) { actions.insert(action("newSession", "session.action.newSession", "square.and.pencil"), at: 0) }
    if !project.rootPath.isEmpty { actions.append(action("copyPath", "project.action.copyPath", "doc.on.doc")) }
    return actions
  }

  static func archive(_ archived: Bool) -> LodyListAction {
    archived
      ? action("archive", "session.action.unarchive", "tray.and.arrow.up")
      : action("archive", "session.action.archive", "archivebox")
  }

  static func pin(_ pinned: Bool) -> LodyListAction {
    var item = pinned ? action("pin", "session.action.unpin", "pin.slash.fill") : action("pin", "session.action.pin", "pin.fill")
    item.tint = "yellow"
    return item
  }

  static func newChat() -> LodyListAction { action("newChat", "session.action.newChat", "square.and.pencil") }

  private static func trailingActions(_ session: SessionItem) -> [LodyListAction] {
    if session.archived { return [archive(true)] }
    let read = action("read", "session.action.read", "envelope.open")
    return needsEmphasis(session) ? [read, archive(false)] : [archive(false)]
  }

  private static func rename() -> LodyListAction { action("rename", "session.action.rename", "pencil") }
  private static func share() -> LodyListAction { action("share", "session.action.share", "square.and.arrow.up") }

  private static func delete() -> LodyListAction {
    var item = action("delete", "session.action.delete", "trash")
    item.destructive = true
    return item
  }

  private static func action(_ id: String, _ key: String, _ symbol: String) -> LodyListAction {
    var item = LodyListAction()
    item.id = id
    item.title = String(localized: String.LocalizationValue(key), bundle: .lody)
    item.symbol = symbol
    return item
  }
}


enum DirectoryTabs {
  static func sessions(current: SessionItem, all: [SessionItem]) -> [SessionItem] {
    family(current: current, all: all).filter { !$0.isTabClosed }
  }

  static func closed(current: SessionItem, all: [SessionItem]) -> [SessionItem] {
    family(current: current, all: all).filter { $0.isTabClosed }
  }

  static func root(_ current: SessionItem, all: [SessionItem]) -> String {
    root(current, indexed: Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }))
  }

  static func root(_ current: SessionItem, indexed: [String: SessionItem]) -> String {
    var id = current.id
    var seen = Set<String>()
    while seen.insert(id).inserted {
      guard let parent = indexed[id]?.parentSessionId, !parent.isEmpty else { return id }
      id = parent
    }
    return current.id
  }

  private static func family(current: SessionItem, all: [SessionItem]) -> [SessionItem] {
    let indexed = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    let owner = root(current, indexed: indexed)
    return all.filter { !$0.archived && $0.childSessionPlacement != "side-panel" && $0.machineId == current.machineId && root($0, indexed: indexed) == owner }
      .sorted { left, right in
        if left.id != right.id && left.id == owner { return true }
        if right.id == owner { return false }
        if left.createdAt != right.createdAt { return left.createdAt < right.createdAt }
        return left.id < right.id
      }
  }

  static func symbol(_ sessions: [SessionItem]) -> String {
    for state: SessionState in [.attention, .failed, .live] {
      if sessions.contains(where: { SessionState($0) == state }) {
        switch state {
        case .attention: return "hand.raised"
        case .failed: return "exclamationmark.circle"
        default: return "square.grid.2x2.fill"
        }
      }
    }
    return sessions.contains(where: SessionRows.isUnread) ? "circle.fill" : ""
  }
}
