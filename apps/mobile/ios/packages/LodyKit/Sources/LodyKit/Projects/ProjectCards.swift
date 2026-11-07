import Foundation

/// Which projects the Projects tab lists (its view menu).
enum ProjectSource: String, CaseIterable, Sendable {
  case all, github, local

  private static let key = "projectsSource"
  private static let hideEmptyKey = "projectsHideEmpty"

  static var stored: ProjectSource {
    UserDefaults.standard.string(forKey: key).flatMap(ProjectSource.init(rawValue:)) ?? .all
  }

  static func store(_ value: ProjectSource) {
    UserDefaults.standard.set(value.rawValue, forKey: key)
    NotificationCenter.default.post(name: .lodyHomeGroupingChanged, object: nil)
  }

  static var hidesEmpty: Bool { UserDefaults.standard.bool(forKey: hideEmptyKey) }

  static func storeHidesEmpty(_ value: Bool) {
    UserDefaults.standard.set(value, forKey: hideEmptyKey)
    NotificationCenter.default.post(name: .lodyHomeGroupingChanged, object: nil)
  }
}

/// One Projects card: the project, where it runs, when it last moved, and its open
/// (non-archived) chats counted by Home's status groups. Android: `ProjectCard`.
struct ProjectCard: Identifiable, Equatable, Sendable {
  enum Summary: Equatable, Sendable { case attention, running, finished, pullRequests, open, empty }

  let id: String
  let title: String
  let github: Bool
  /// GitHub: the repository owner's avatar.
  let avatar: String?
  /// Local: the computer it lives on.
  let machine: String?
  /// Latest activity of its open chats (epoch ms); nil when it has none.
  let updatedAt: Double?
  let open: Int
  let attention: Int
  let running: Int
  let finished: Int
  let pullRequests: Int

  /// The one line the card leads with, most pressing first.
  var summary: (Summary, Int) {
    if attention > 0 { return (.attention, attention) }
    if running > 0 { return (.running, running) }
    if finished > 0 { return (.finished, finished) }
    if pullRequests > 0 { return (.pullRequests, pullRequests) }
    if open > 0 { return (.open, open) }
    return (.empty, 0)
  }
}

enum ProjectCards {
  static func isGithub(_ project: SessionProject) -> Bool { project.id.hasPrefix("github:") }

  static func ownerAvatar(_ repo: String) -> String? {
    guard let owner = repo.split(separator: "/").first, !owner.isEmpty,
          let encoded = String(owner).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
    return "https://avatars.githubusercontent.com/\(encoded)?size=96"
  }

  /// Every project (plain chats excluded), newest activity first; projects without open chats
  /// follow by name. `owner` ("My tasks") counts only that user's chats; `query` matches the
  /// name, repository, path and computer.
  static func build(
    _ catalog: SessionCatalog, owner: String?, source: ProjectSource, hideEmpty: Bool, query: String = ""
  ) -> [ProjectCard] {
    // Tabs belong to their parent conversation, so they never count on their own.
    let live = catalog.sessions.filter { !$0.archived && !SessionRows.isTab($0) && (owner == nil || $0.userId == owner) }
    let byProject = Dictionary(grouping: live, by: \.projectId)
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let cards = catalog.projects.compactMap { project -> ProjectCard? in
      guard !SessionRows.isChat(project.id) else { return nil }
      let github = isGithub(project)
      switch source {
      case .all: break
      case .github: guard github else { return nil }
      case .local: guard !github else { return nil }
      }
      let sessions = byProject[project.id] ?? []
      guard !hideEmpty || !sessions.isEmpty else { return nil }
      var groups: [HomeStatusGroup: Int] = [:]
      for session in sessions { groups[HomeStatusGroup(session), default: 0] += 1 }
      let repo = project.repoFullName.flatMap { $0.isEmpty ? nil : $0 }
      let fallback = (project.rootPath as NSString).lastPathComponent
      let machine = github ? nil : catalog.machineNames[project.machineId] ?? (project.machineId.isEmpty ? nil : project.machineId)
      let title = github ? repo ?? project.name : (project.name.isEmpty ? fallback : project.name)
      if !term.isEmpty {
        let fields = [title, project.name, repo ?? "", project.rootPath, machine ?? ""]
        guard fields.contains(where: { $0.localizedStandardContains(term) }) else { return nil }
      }
      let activity = sessions.map(\.activityAt).filter(\.isFinite).max()
      return ProjectCard(
        id: project.id, title: title, github: github, avatar: github ? repo.flatMap(ownerAvatar) : nil,
        machine: machine, updatedAt: activity, open: sessions.count,
        attention: groups[.attention] ?? 0, running: groups[.running] ?? 0,
        finished: groups[.finished] ?? 0, pullRequests: groups[.pullRequest] ?? 0
      )
    }
    return cards.sorted { lhs, rhs in
      switch (lhs.updatedAt, rhs.updatedAt) {
      case let (left?, right?) where left != right: return left > right
      case (.some, .none): return true
      case (.none, .some): return false
      default: return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
      }
    }
  }
}
