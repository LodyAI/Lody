import Foundation

struct GitHubAuthorization: Codable, Equatable, Sendable {
  enum State: String, Codable, Sendable { case missing, expired, authorized }
  struct Profile: Codable, Equatable, Sendable { var login: String }

  var state: State
  var githubAccountId: String?
  var profile: Profile?

  var valid: Bool {
    guard state == .authorized else { return true }
    return githubAccountId?.isEmpty == false && profile.map { !$0.login.isEmpty } ?? true
  }
}

struct GitHubRepository: Codable, Equatable, Sendable {
  var repoFullName: String
  var name: String
  var repositoryId: Double
  var `private`: Bool
  var enabled: Bool

  var valid: Bool {
    let parts = repoFullName.split(separator: "/", omittingEmptySubsequences: false)
    return parts.count == 2 && parts.allSatisfy { !$0.isEmpty && !$0.contains(where: \.isWhitespace) }
      && repositoryId > 0 && repositoryId.rounded() == repositoryId && repositoryId <= 9_007_199_254_740_991
  }
}

struct GitHubPersonal: Codable, Equatable, Sendable {
  var enabled: Bool
  var authorization: GitHubAuthorization
}

struct GitHubSettings: Codable, Equatable, Sendable {
  enum Source: String, Codable, Sendable { case repositories, personal }

  var canManage: Bool
  var roleKnown: Bool
  var repositories: [GitHubRepository]?
  var personal: GitHubPersonal?
  var errors: [Source]

  var valid: Bool {
    (repositories?.count ?? 0) <= 10000 && repositories?.allSatisfy(\.valid) != false
      && personal?.authorization.valid != false
  }
}

struct GitHubSettingsRequest: Encodable, Equatable, Sendable {
  var page = "github"
  var workspaceId: String
  var action: String
  var repoFullName: String?
  var enabled: Bool?
}

enum GitHubSettingsResult: Equatable, Sendable {
  case settings(GitHubSettings)
  case url(URL)
  case authorizationRequired
}

typealias GitHubSettingsService = @MainActor (GitHubSettingsRequest) async throws -> GitHubSettingsResult

enum GitHubSettingsSections {
  /// The existing neutral callback resolves the deployment's Web origin; no credentials enter it.
  static var authorizationURL: URL {
    var url = URLComponents(url: URL(string: BackendEnvironment.site)!, resolvingAgainstBaseURL: false)!
    url.path = "/api/github/callback"
    url.queryItems = [URLQueryItem(name: "setup_action", value: "request")]
    return url.url!
  }

  static func installURL(_ value: String) -> URL? {
    guard let components = URLComponents(string: value), let url = components.url,
          components.scheme?.lowercased() == "https", components.host?.lowercased() == "github.com",
          components.port == nil || components.port == 443,
          components.user?.isEmpty != false, components.password?.isEmpty != false,
          components.fragment?.isEmpty != false,
          components.percentEncodedPath == "/apps/lodyai/installations/new",
          components.queryItems?.first(where: { $0.name == "state" })?.value?.isEmpty == false else { return nil }
    return url
  }

  /// The page reads top-down: who acts on GitHub for you, managing the workspace's GitHub App,
  /// then the (possibly long) list of repositories it may use, as native switches with the
  /// owner's logo.
  /// A search keeps only the matching repositories.
  static func make(_ value: GitHubSettings?, enabled: Bool, query: String = "") -> [LodyListSection] {
    let canManage = value?.canManage == true
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let repositories = sorted(value?.repositories ?? [])
    if !needle.isEmpty {
      let matches = repositories.filter { $0.repoFullName.localizedCaseInsensitiveContains(needle) }
      var section = repositorySection(value, matches, total: repositories, enabled: enabled && canManage)
      section.footer = matches.isEmpty ? String(format: text("noMatches"), needle) : ""
      return [section]
    }
    var sections = [personalSection(value?.personal, enabled: enabled)]
    if canManage {
      var row = LodyListRow()
      row.id = "install"
      row.title = text("manageApp")
      row.imageAsset = "lody.icon.github"
      row.trailingSymbol = "arrow.up.right"
      row.action = enabled
      var section = SettingsText.footer("installation", text("browserHint"))
      section.rows = [row]
      sections.append(section)
    }
    if let value, value.repositories == nil {
      var row = LodyListRow()
      row.id = "repo-unavailable"
      row.title = text("repoUnavailable")
      row.image = "exclamationmark.triangle"
      row.imageTint = "secondary"
      var section = LodyListSection()
      section.id = "repositories-unavailable"
      section.header = text("repositories")
      section.rows = [row]
      sections.append(section)
    } else {
      var section = repositorySection(value, repositories, total: repositories, enabled: enabled && canManage)
      var hint = text("roleUnknown")
      if value?.roleKnown == true { hint = text(canManage ? "repositoryHint" : "readonly") }
      section.footer = repositories.isEmpty && value != nil ? text("empty") + "\n\n" + hint : hint
      sections.append(section)
    }
    return sections
  }

  private static func personalSection(_ personal: GitHubPersonal?, enabled: Bool) -> LodyListSection {
    let authorization = personal?.authorization
    let login = authorization?.state == .authorized ? authorization?.profile?.login ?? "" : ""
    var identity = LodyListRow()
    identity.id = "identity"
    identity.title = login.isEmpty ? text(authorization?.state.rawValue ?? "unknown") : login
    if let authorization { identity.subtitle = login.isEmpty ? text(authorization.state.rawValue + "Hint") : text("authorized") }
    if let url = avatarURL(login) {
      identity.image = url.absoluteString
    } else {
      identity.image = authorization?.state == .expired ? "person.crop.circle.badge.exclamationmark" : "person.crop.circle"
      identity.imageTint = "secondary"
    }
    var section = LodyListSection()
    section.id = "personal"
    section.header = text("personal")
    section.footer = text("personalHint")
    section.rows = [identity]
    if let personal {
      var row = LodyListRow()
      row.id = "preference"
      row.title = text("personalPreference")
      row.toggle = personal.enabled
      // Turning it on needs a live authorization; turning it off never does.
      row.action = enabled && (personal.enabled || personal.authorization.state == .authorized)
      section.rows.append(row)
    }
    return section
  }

  private static func repositorySection(
    _ value: GitHubSettings?, _ rows: [GitHubRepository], total: [GitHubRepository], enabled: Bool
  ) -> LodyListSection {
    var section = LodyListSection()
    section.id = "repositories"
    section.header = text("repositories")
    if value?.repositories != nil, !total.isEmpty {
      section.headerValue = String(format: text("enabledCount"), total.filter(\.enabled).count, total.count)
    }
    section.rows = rows.map { repo in
      let owner = repo.repoFullName.split(separator: "/").first.map(String.init) ?? ""
      var row = LodyListRow()
      row.id = "repo:\(repo.repoFullName)"
      row.title = repo.name.isEmpty ? repo.repoFullName : repo.name
      row.subtitle = [owner, text(repo.private ? "private" : "public")].filter { !$0.isEmpty }.joined(separator: " · ")
      row.repository = repo.repoFullName
      row.toggle = repo.enabled
      row.action = enabled
      return row
    }
    return section
  }

  static func sorted(_ repositories: [GitHubRepository]) -> [GitHubRepository] {
    repositories.sorted { $0.repoFullName.localizedCaseInsensitiveCompare($1.repoFullName) == .orderedAscending }
  }

  static func avatarURL(_ login: String) -> URL? {
    guard !login.isEmpty, login.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return nil }
    return URL(string: "https://avatars.githubusercontent.com/\(login)?size=96")
  }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.github." + key), bundle: .lody) }
}
