import Foundation

struct InboxSearchHits: Equatable, Sendable {
  var projectIds: [String] = []
  var sessions: [(id: String, snippet: String?)] = []

  static func == (left: InboxSearchHits, right: InboxSearchHits) -> Bool {
    left.projectIds == right.projectIds
      && left.sessions.map(\.id) == right.sessions.map(\.id) && left.sessions.map(\.snippet) == right.sessions.map(\.snippet)
  }
}

enum InboxSort: String, CaseIterable, Sendable {
  case name, activity, urgency
}

enum InboxSections {
  static let chatId = "chat"
  static let pinnedId = "pinned"
  private static let groups = ["pinned", "attention", "live", "unread", "today", "yesterday", "week", "month", "older"]
  private static let day = 86_400_000.0

  static func inbox(
    _ catalog: SessionCatalog, keyword: String = "", chatOnly: Bool = false, pinOrder: [String] = [],
    now: Double = LodyRelativeTime.now()
  ) -> [LodyListSection] {
    let names = projectNames(catalog)
    let term = keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let visible = catalog.sessions
      .filter { !chatOnly || SessionRows.isChat($0.projectId) }
      .filter { !$0.archived || !term.isEmpty }
      .filter { term.isEmpty || "\($0.title) \(place($0, names))".lowercased().contains(term) }
      .sorted(by: SessionRows.byActivity)
    var buckets: [String: [SessionItem]] = [:]
    for family in SessionRows.tree(visible, all: catalog.sessions) {
      buckets[group(family.session, now: now), default: []] += [family.session] + family.children
    }
    return groups.compactMap { id in
      var sessions = buckets[id] ?? []
      if id == pinnedId { sessions = orderPinned(sessions, pinOrder: pinOrder) }
      let rows = SessionRows.treeRows(sessions, all: catalog.sessions) { session in
        var row = SessionRows.row(session, projectName: place(session, names), now: now)
        let state = SessionState(session)
        row.diff = [:]
        row.imageTint = state == .live || !state.badge.isEmpty ? state.tint : ""
        return row
      }
      guard !rows.isEmpty else { return nil }
      return section(id, header: String(localized: String.LocalizationValue("inbox.section." + id), bundle: .lody), rows: rows)
    }
  }

  static func projects(
    _ catalog: SessionCatalog, expanded: [String: Bool] = [:], sort: InboxSort = .name, pinOrder: [String] = [],
    now: Double = LodyRelativeTime.now()
  ) -> [LodyListSection] {
    let unpinned = catalog.sessions.filter { !$0.pinned && !$0.archived }
    let pinned = orderPinned(catalog.sessions.filter { $0.pinned && !$0.archived }, pinOrder: pinOrder)
    var sections = sortProjects(catalog.projects, sessions: unpinned, sort: sort).map { project in
      let sessions = unpinned.filter { $0.projectId == project.id }.sorted(by: SessionRows.byActivity)
      let open = expanded[project.id] ?? true
      var group = sessionGroup(
        project.id, parent: projectRow(project, sessions: sessions, open: open), sessions: sessions, all: catalog.sessions,
        now: now
      )
      group.headerExpanded = open
      return group
    }
    let chats = unpinned.filter { SessionRows.isChat($0.projectId) }.sorted(by: SessionRows.byActivity)
    if !chats.isEmpty {
      let open = expanded[chatId] ?? true
      var parent = LodyListRow()
      parent.id = "toggle:\(chatId)"
      parent.parent = true
      parent.image = "bubble.left"
      parent.title = String(localized: "inbox.section.chat", bundle: .lody)
      parent.action = true
      parent.menuActions = [SessionRows.newChat()]
      trailing(&parent, sessions: chats, open: open)
      var group = sessionGroup(chatId, parent: parent, sessions: chats, all: catalog.sessions, now: now, moreId: "view:\(chatId)")
      group.headerExpanded = open
      group.gap = .group
      sections.append(group)
    }
    guard !pinned.isEmpty else { return sections }
    let rows = SessionRows.treeRows(pinned, all: catalog.sessions) { SessionRows.row($0, now: now) }
    if !sections.isEmpty { sections[0].gap = .group }
    return [pinnedSection(rows, expanded: expanded)] + sections
  }

  /// iPhone Home in the view menu's grouping; archived chats are hidden.
  /// - Parameter owner: when set ("My tasks"), only chats owned by this user id are listed.
  static func home(
    _ catalog: SessionCatalog, grouping: HomeGrouping, owner: String? = nil, idleExpanded: Bool = false,
    now: Double = LodyRelativeTime.now()
  ) -> [LodyListSection] {
    var catalog = catalog
    if let owner { catalog.sessions = owned(catalog.sessions, by: owner) }
    var home = HomeRows(catalog, now: now)
    let pinned = home.families.filter { $0.session.pinned || $0.children.contains(where: \.pinned) }
    home.families.removeAll { $0.session.pinned || $0.children.contains(where: \.pinned) }
    let sections: [LodyListSection] = switch grouping {
    case .time: timeline(home)
    case .project: byProject(home)
    case .status: byStatus(home, idleExpanded: idleExpanded)
    }
    guard !pinned.isEmpty else { return sections }
    return [section(pinnedId, header: String(localized: "inbox.section.pinned", bundle: .lody), rows: home.rows(pinned))] + sections
  }

  /// Keep complete families containing the owner's chats, including parent context.
  static func owned(_ sessions: [SessionItem], by owner: String) -> [SessionItem] {
    let indexed = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    let included = Set(SessionRows.tree(sessions, indexed: indexed).flatMap { family in
      let members = [family.session] + family.children
      return members.contains { $0.userId == owner } ? members.map(\.id) : []
    })
    return sessions.filter { included.contains(DirectoryTabs.root($0, indexed: indexed)) }
  }

  /// Quiet chats beyond this many top-level rows fold behind "Show all" in the status view.
  static let idleLimit = 20
  static let idleMoreId = "view:idle"

  /// Activity buckets only (no pinned / status groups).
  static func timeline(_ catalog: SessionCatalog, now: Double = LodyRelativeTime.now()) -> [LodyListSection] {
    timeline(HomeRows(catalog, now: now))
  }

  private static func timeline(_ home: HomeRows) -> [LodyListSection] {
    var buckets: [String: [SessionRows.Family]] = [:]
    for family in home.families {
      buckets[activityBucket(family.session.activityAt, now: home.now), default: []].append(family)
    }
    return ["today", "yesterday", "week", "month", "older"].compactMap { id in
      guard let sessions = buckets[id], !sessions.isEmpty else { return nil }
      return section(id, header: String(localized: String.LocalizationValue("inbox.section." + id), bundle: .lody), rows: home.rows(sessions))
    }
  }

  /// One group per project, most recently active first; unassigned chats form the "Chat" group.
  /// The header names the project, so rows drop it from their detail line.
  static func byProject(_ catalog: SessionCatalog, now: Double = LodyRelativeTime.now()) -> [LodyListSection] {
    byProject(HomeRows(catalog, now: now))
  }

  private static func byProject(_ home: HomeRows) -> [LodyListSection] {
    var order: [String] = []
    var groups: [String: [SessionRows.Family]] = [:]
    for family in home.families {
      let key = SessionRows.isChat(family.session.projectId) ? chatId : family.session.projectId
      if groups[key] == nil { order.append(key) }
      groups[key, default: []].append(family)
    }
    return order.map { key in
      let header = key == chatId ? String(localized: "inbox.section.chat", bundle: .lody) : home.names[key] ?? ""
      return section("group:\(key)", header: header, rows: home.rows(groups[key] ?? [], showsPlace: false))
    }
  }

  /// `HomeStatusGroup` order; the idle group shows `idleLimit` chats until expanded.
  static func byStatus(_ catalog: SessionCatalog, idleExpanded: Bool = false, now: Double = LodyRelativeTime.now()) -> [LodyListSection] {
    byStatus(HomeRows(catalog, now: now), idleExpanded: idleExpanded)
  }

  private static func byStatus(_ home: HomeRows, idleExpanded: Bool) -> [LodyListSection] {
    var groups: [HomeStatusGroup: [SessionRows.Family]] = [:]
    for family in home.families {
      groups[HomeStatusGroup(family.session, attention: home.attention[family.session.id]), default: []].append(family)
    }
    return HomeStatusGroup.allCases.compactMap { group in
      guard let sessions = groups[group], !sessions.isEmpty else { return nil }
      let header = String(localized: String.LocalizationValue("home.group." + group.rawValue), bundle: .lody)
      guard group == .idle else { return section(group.rawValue, header: header, rows: home.rows(sessions)) }
      let roots = sessions.count
      var rows = home.rows(sessions, maxRoots: idleExpanded ? .max : idleLimit)
      if roots > idleLimit {
        var toggle = LodyListRow()
        toggle.id = idleMoreId
        toggle.title = idleExpanded
          ? String(localized: "home.group.showLess", bundle: .lody)
          : String.localizedStringWithFormat(String(localized: "home.group.showAll", bundle: .lody), roots)
        toggle.action = true
        rows.append(toggle)
      }
      return section(group.rawValue, header: header, rows: rows)
    }
  }

  /// Shared row building for the Home groupings.
  private struct HomeRows {
    let now: Double
    let names: [String: String]
    let repos: Set<String>
    let repositories: [String: String]
    var families: [SessionRows.Family]
    let attention: [String: SessionRows.ListAttention]

    init(_ catalog: SessionCatalog, now: Double) {
      let indexed = Dictionary(catalog.sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
      attention = SessionRows.conversationAttention(catalog.sessions, indexed: indexed)
      self.now = now
      names = InboxSections.projectNames(catalog)
      repositories = Dictionary(catalog.projects.compactMap { project in project.repoFullName.map { (project.id, $0) } }, uniquingKeysWith: { first, _ in first })
      repos = Set(catalog.projects.filter { !($0.repoFullName ?? "").isEmpty }.map(\.id))
      let visible = catalog.sessions.filter { !$0.archived }.sorted { $0.activityAt > $1.activityAt }
      families = SessionRows.tree(visible, indexed: indexed)
    }

    func rows(_ families: [SessionRows.Family], showsPlace: Bool = true, maxRoots: Int = .max) -> [LodyListRow] {
      let rootProjects = Set(families.map { $0.session.projectId })
      return SessionRows.treeRows(families, attention: attention, maxRoots: maxRoots) { session in
        var row = SessionRows.row(session, projectName: InboxSections.place(session, names), now: now)
        row.place = (showsPlace || !rootProjects.contains(session.projectId)) && !SessionRows.isChat(session.projectId) ? names[session.projectId] ?? "" : ""
        row.placeIsRepo = repos.contains(session.projectId)
        row.repository = repositories[session.projectId] ?? ""
        return row
      }
    }
  }

  /// iPhone Projects tab: one row per project with its open chat count and most urgent state.
  static func search(
    _ catalog: SessionCatalog, hits: InboxSearchHits, query: String = "", now: Double = LodyRelativeTime.now()
  ) -> [LodyListSection] {
    let names = projectNames(catalog)
    let projectIds = Set(hits.projectIds)
    let snippets = Dictionary(hits.sessions.map { ($0.id, $0.snippet) }, uniquingKeysWith: { first, _ in first })
    let projects = catalog.projects.filter { projectIds.contains($0.id) }.map { project in
      var row = LodyListRow()
      row.id = "project:\(project.id)"
      row.title = project.name
      row.subtitle = project.rootPath
      row.image = "folder"
      row.action = true
      row.disclosure = true
      row.navigates = true
      row.menuActions = SessionRows.projectMenu(project)
      row.highlight = query
      return row
    }
    let sessions = catalog.sessions.filter { snippets[$0.id] != nil }.sorted(by: SessionRows.byActivity)
    let rows = SessionRows.treeRows(sessions, all: catalog.sessions) { session in
      var row = SessionRows.row(session, projectName: place(session, names), now: now)
      row.highlight = query
      if let snippet = snippets[session.id] ?? nil {
        row.subtitle = snippet
        row.subtitleMono = false
        row.wrapSubtitle = true
      }
      return row
    }
    return [
      section("projects", header: String(localized: "inbox.section.projects", bundle: .lody), rows: projects),
      section("sessions", header: String(localized: "inbox.section.sessions", bundle: .lody), rows: rows),
    ].filter { !$0.rows.isEmpty }
  }

  static func match(_ catalog: SessionCatalog, keyword: String) -> InboxSearchHits {
    let term = keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !term.isEmpty else { return InboxSearchHits() }
    let names = projectNames(catalog)
    let projects = catalog.projects.filter { !SessionRows.isChat($0.id) && $0.name.lowercased().contains(term) }
    let sessions = catalog.sessions
      .filter { "\($0.title) \(place($0, names))".lowercased().contains(term) }
      .sorted(by: SessionRows.byActivity)
    return InboxSearchHits(projectIds: projects.map(\.id), sessions: sessions.map { ($0.id, nil) })
  }

  static func isChatRow(_ id: String) -> Bool {
    ["chat", "toggle:chat", "view:chat", "project:chat"].contains(id)
  }

  static func reconcilePinOrder(_ order: [String], pinned: [String], activity: (String) -> Double) -> [String] {
    let current = Set(pinned)
    let kept = order.filter { current.contains($0) }
    let known = Set(kept)
    let unknown = pinned.filter { !known.contains($0) }.sorted { left, right in
      let (a, b) = (activity(left), activity(right))
      return a == b ? left < right : a > b
    }
    return unknown + kept
  }

  static func orderPinned(_ sessions: [SessionItem], pinOrder: [String]) -> [SessionItem] {
    let rank = Dictionary(pinOrder.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
    return sessions.sorted { left, right in
      let (a, b) = (rank[left.id] ?? .max, rank[right.id] ?? .max)
      return a == b ? left.activityAt > right.activityAt : a < b
    }
  }

  static func sortProjects(_ projects: [SessionProject], sessions: [SessionItem], sort: InboxSort) -> [SessionProject] {
    let owned = projects.filter { !SessionRows.isChat($0.id) }
    var latest: [String: Double] = [:]
    var urgency: [String: Int] = [:]
    if sort != .name {
      for session in sessions where !session.archived {
        latest[session.projectId] = max(latest[session.projectId] ?? 0, session.activityAt)
        if sort == .urgency {
          let state = SessionState(session)
          let rank: Int
          if state == .attention || state == .failed { rank = 0 }
          else if state == .live { rank = 1 }
          else { rank = 2 }
          urgency[session.projectId] = min(urgency[session.projectId] ?? 2, rank)
        }
      }
    }
    return owned.sorted { left, right in
      if sort != .name {
        if sort == .urgency {
          let rank = (urgency[left.id] ?? 2) - (urgency[right.id] ?? 2)
          if rank != 0 { return rank < 0 }
        }
        let activity = (latest[right.id] ?? 0) - (latest[left.id] ?? 0)
        if activity != 0 { return activity < 0 }
      }
      return left.name.localizedCompare(right.name) == .orderedAscending
    }
  }

  static func activityBucket(_ value: Double, now: Double, calendar: Calendar = .current) -> String {
    let today = calendar.startOfDay(for: Date(timeIntervalSince1970: now / 1000)).timeIntervalSince1970 * 1000
    if value.isNaN || value >= today { return "today" }
    if value >= today - day { return "yesterday" }
    if value >= today - 7 * day { return "week" }
    if value >= today - 30 * day { return "month" }
    return "older"
  }

  private static func group(_ session: SessionItem, now: Double) -> String {
    if session.pinned { return pinnedId }
    let state = SessionState(session)
    if state == .attention || state == .failed { return "attention" }
    if state == .live { return "live" }
    if SessionRows.isUnread(session) { return "unread" }
    return activityBucket(session.activityAt, now: now)
  }

  fileprivate static func projectNames(_ catalog: SessionCatalog) -> [String: String] {
    Dictionary(catalog.projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
  }

  static func place(_ session: SessionItem, _ names: [String: String]) -> String {
    SessionRows.isChat(session.projectId) ? String(localized: "inbox.section.chat", bundle: .lody) : names[session.projectId] ?? ""
  }

  private static func projectRow(_ project: SessionProject, sessions: [SessionItem], open: Bool) -> LodyListRow {
    var row = LodyListRow()
    row.id = sessions.isEmpty ? "project:\(project.id)" : "toggle:\(project.id)"
    row.parent = true
    row.monogram = String(project.name.prefix(1))
    row.image = ownerAvatar(project.repoFullName ?? "")
    row.title = project.name
    row.subtitle = project.rootPath.replacingOccurrences(of: #"^/(Users|home)/[^/]+"#, with: "~", options: .regularExpression)
    row.subtitleMono = true
    row.action = true
    row.menuActions = SessionRows.projectMenu(project)
    trailing(&row, sessions: sessions, open: open)
    return row
  }

  private static func ownerAvatar(_ repo: String) -> String {
    guard let owner = repo.split(separator: "/").first, !owner.isEmpty,
      let encoded = String(owner).addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-._~")))
    else { return "" }
    return "https://avatars.githubusercontent.com/\(encoded)?size=96"
  }

  private static func trailing(_ row: inout LodyListRow, sessions: [SessionItem], open: Bool) {
    guard !sessions.isEmpty else {
      row.badge = "0"
      row.disclosure = true
      row.navigates = true
      return
    }
    let states = sessions.map(SessionState.init)
    guard open else {
      row.badge = String(sessions.count)
      // Collapsed groups keep their most urgent state visible beside the count.
      row.imageTint = [SessionState.attention, .failed, .live].first(where: states.contains)?.tint ?? ""
      return
    }
    for state in [SessionState.failed, .attention, .live] {
      let count = states.filter { $0 == state }.count
      guard count > 0 else { continue }
      row.value = String.localizedStringWithFormat(String(localized: String.LocalizationValue("inbox.project." + state.rawValue), bundle: .lody), count)
      row.imageTint = state.tint
      return
    }
  }

  private static func sessionGroup(
    _ id: String, parent: LodyListRow, sessions: [SessionItem], all: [SessionItem], now: Double, moreId: String? = nil
  ) -> LodyListSection {
    var rows = [parent] + SessionRows.treeRows(sessions, all: all, maxRoots: 5) { SessionRows.row($0, now: now) }
    let rest = sessions.count - (rows.count - 1)
    if rest > 0 {
      var more = LodyListRow()
      more.id = moreId ?? "project:\(id)"
      more.title = String.localizedStringWithFormat(String(localized: "inbox.project.more", bundle: .lody), rest)
      more.action = true
      more.disclosure = true
      more.navigates = true
      rows.append(more)
    }
    return section(id, rows: rows)
  }

  private static func pinnedSection(_ rows: [LodyListRow], expanded: [String: Bool]) -> LodyListSection {
    var parent = LodyListRow()
    parent.id = "toggle:\(pinnedId)"
    parent.parent = true
    parent.image = "pin.fill"
    parent.title = String(localized: "inbox.section.pinned", bundle: .lody)
    parent.action = true
    var group = section(pinnedId, rows: [parent] + rows)
    group.headerExpanded = expanded[pinnedId] ?? true
    return group
  }

  private static func section(_ id: String, header: String = "", rows: [LodyListRow]) -> LodyListSection {
    var section = LodyListSection()
    section.id = id
    section.header = header
    section.rows = rows
    return section
  }
}
