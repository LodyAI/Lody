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
}

typealias GitHubSettingsService = @MainActor (GitHubSettingsRequest) async throws -> GitHubSettingsResult

enum GitHubSettingsSections {
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

  static func make(_ value: GitHubSettings?, enabled: Bool) -> [LodyListSection] {
    let personal = value?.personal
    var identity = LodyListRow()
    identity.id = "identity"
    identity.title = text(personal?.authorization.state.rawValue ?? "unknown")
    if personal?.authorization.state == .authorized { identity.subtitle = personal?.authorization.profile?.login ?? "" }
    identity.image = "person.crop.circle"
    var personalSection = LodyListSection()
    personalSection.id = "personal"
    personalSection.header = text("personal")
    personalSection.footer = text("personalHint")
    personalSection.rows = [identity]
    if let personal {
      var options = [SettingsText.option("disabled", remote(false), selected: !personal.enabled)]
      if personal.authorization.state == .authorized {
        options.append(SettingsText.option("enabled", remote(true), selected: personal.enabled))
      }
      var row = LodyListRow()
      row.id = "preference"
      row.title = text("personalPreference")
      row.accessibilityValue = remote(personal.enabled)
      row.value = remote(personal.enabled)
      row.action = enabled
      row.options = options
      personalSection.rows.append(row)
    }
    var hint = text("roleUnknown")
    if value?.roleKnown == true { hint = text(value?.canManage == true ? "repositoryHint" : "readonly") }
    let canManage = value?.canManage == true
    var repositories = LodyListSection()
    repositories.id = "repositories"
    repositories.header = text("repositories")
    repositories.footer = hint
    repositories.rows = (value?.repositories ?? []).map { repo in
      var row = LodyListRow()
      row.id = "repo:\(repo.repoFullName)"
      row.title = repo.repoFullName
      row.subtitle = text(repo.private ? "private" : "public")
      row.accessibilityValue = remote(repo.enabled)
      row.value = remote(repo.enabled)
      row.action = enabled && canManage
      if canManage {
        row.options = [
          SettingsText.option("enabled", remote(true), selected: repo.enabled),
          SettingsText.option("disabled", remote(false), selected: !repo.enabled),
        ]
      }
      return row
    }
    var sections = [personalSection, repositories]
    if let value, value.repositories == nil {
      var row = LodyListRow()
      row.id = "repo-unavailable"
      row.title = text("repoUnavailable")
      var section = LodyListSection()
      section.id = "repositories-unavailable"
      section.rows = [row]
      sections.append(section)
    }
    if value?.repositories?.isEmpty == true { sections.append(SettingsText.footer("no-repositories", text("empty"))) }
    if canManage {
      var row = LodyListRow()
      row.id = "install"
      row.title = text("manageApp")
      row.image = "safari"
      row.action = enabled
      var section = SettingsText.footer("installation", text("browserHint"))
      section.rows = [row]
      sections.append(section)
    }
    return sections
  }

  private static func remote(_ enabled: Bool) -> String {
    String(localized: String.LocalizationValue(enabled ? "settings.remote.enabled" : "settings.remote.disabled"), bundle: .lody)
  }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.github." + key), bundle: .lody) }
}
