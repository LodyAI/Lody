import UIKit

@MainActor
final class GitHubSettingsPreviewController: GitHubSettingsController {
  init() {
    let fixture = GitHubSettingsFixture()
    super.init(workspace: "github-fixture", service: { try await fixture.request($0) }, changed: {}, open: { _ in })
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

@MainActor
private final class GitHubSettingsFixture {
  private var first = true
  private var failWrite = true
  private var data = GitHubSettings(
    canManage: true,
    roleKnown: true,
    repositories: [
      GitHubRepository(repoFullName: "LodyAI/Lody", name: "Lody", repositoryId: 1, private: false, enabled: true),
      GitHubRepository(repoFullName: "LodyAI/lody-ios", name: "lody-ios", repositoryId: 2, private: true, enabled: false),
      GitHubRepository(repoFullName: "loro-dev/loro", name: "loro", repositoryId: 3, private: false, enabled: true),
      GitHubRepository(repoFullName: "octo-fixture/sandbox", name: "sandbox", repositoryId: 4, private: true, enabled: false),
    ],
    personal: GitHubPersonal(enabled: true, authorization: GitHubAuthorization(state: .expired, githubAccountId: "fixture")),
    errors: []
  )

  func request(_ request: GitHubSettingsRequest) async throws -> GitHubSettingsResult {
    if first {
      first = false
      throw CocoaError(.fileReadUnknown)
    }
    if request.action == "install",
       let url = GitHubSettingsSections.installURL("https://github.com/apps/lodyai/installations/new?state=offline-fixture") {
      return .url(url)
    }
    if request.action == "repository", let enabled = request.enabled {
      if failWrite {
        failWrite = false
        throw CocoaError(.fileWriteUnknown)
      }
      if let index = data.repositories?.firstIndex(where: { $0.repoFullName == request.repoFullName }) {
        data.repositories?[index].enabled = enabled
      }
    }
    if request.action == "preference", let enabled = request.enabled { data.personal?.enabled = enabled }
    return .settings(data)
  }
}
