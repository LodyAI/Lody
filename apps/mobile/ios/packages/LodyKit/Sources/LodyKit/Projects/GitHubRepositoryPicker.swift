import LodyDesignSystem
import SwiftUI
import UIKit

/// Adds a GitHub repository as a project (web's workspace repository settings, mobile-shaped):
/// the repositories the workspace's Lody GitHub App can reach, searchable, the ones not yet
/// added first. Adding one enables it for the workspace (`github:setRepoEnabled`, admins and
/// owners). When a repository is missing, an admin can open GitHub to grant the app access.
@MainActor
final class GitHubRepositoryModel: ObservableObject {
  enum Phase: Equatable { case loading, failed, ready }

  @Published var phase: Phase = .loading
  @Published var query = ""
  @Published var adding: String?
  @Published var settings: GitHubSettings?
  @Published var error: String?
  @Published var authorizationRequired = false
  let workspaceId: String
  var service: (GitHubSettingsRequest) async throws -> GitHubSettingsResult = GitHubSettingsController.cloud
  var onAdded: (String) -> Void = { _ in }

  init(workspaceId: String) { self.workspaceId = workspaceId }

  var canManage: Bool { settings?.canManage == true }

  /// Not yet added first, then added; each by name. Search matches owner and name.
  var repositories: [GitHubRepository] {
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return (settings?.repositories ?? [])
      .filter { term.isEmpty || $0.repoFullName.localizedStandardContains(term) }
      .sorted { lhs, rhs in
        if lhs.enabled != rhs.enabled { return !lhs.enabled }
        return lhs.repoFullName.localizedStandardCompare(rhs.repoFullName) == .orderedAscending
      }
  }

  func load() {
    phase = .loading
    error = nil
    Task {
      do {
        guard case .settings(let next) = try await service(GitHubSettingsRequest(workspaceId: workspaceId, action: "list")),
              !next.errors.contains(.repositories) else { throw CocoaError(.coderInvalidValue) }
        settings = next
        phase = .ready
      } catch {
        phase = .failed
      }
    }
  }

  func add(_ repo: GitHubRepository) {
    guard canManage, !repo.enabled, adding == nil else { return }
    adding = repo.repoFullName
    error = nil
    Task {
      do {
        let result = try await service(GitHubSettingsRequest(workspaceId: workspaceId, action: "repository", repoFullName: repo.repoFullName, enabled: true))
        if case .settings(let next) = result { settings = next }
        adding = nil
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onAdded(repo.repoFullName)
      } catch {
        adding = nil
        self.error = String(localized: "projects.github.addFailed", bundle: .lody)
        UINotificationFeedbackGenerator().notificationOccurred(.error)
      }
    }
  }

  func install() {
    Task {
      switch try? await service(GitHubSettingsRequest(workspaceId: workspaceId, action: "install")) {
      case .url(let url):
        await UIApplication.shared.open(url)
      case .authorizationRequired:
        authorizationRequired = true
      default:
        error = String(localized: "projects.github.installFailed", bundle: .lody)
      }
    }
  }
}

struct GitHubRepositoryPicker: View {
  @ObservedObject var model: GitHubRepositoryModel

  var body: some View {
    VStack(spacing: 0) {
      search
      switch model.phase {
      case .loading:
        Spacer()
        ProgressView()
        Spacer()
      case .failed:
        message(String(localized: "projects.github.loadFailed", bundle: .lody)) {
          Button(String(localized: "common.retry", bundle: .lody)) { model.load() }
            .buttonStyle(.glass)
        }
      case .ready:
        if model.settings?.repositories?.isEmpty != false {
          message(String(localized: String.LocalizationValue(model.canManage ? "projects.github.noRepositories" : "projects.github.noRepositoriesMember"), bundle: .lody)) {
            if model.canManage { installButton }
          }
        } else {
          list
        }
      }
    }
    .background(LodyColor.bgBase)
    .onAppear { if model.settings == nil { model.load() } }
    .alert(GitHubSettingsSections.text("authorizationRequired"), isPresented: $model.authorizationRequired) {
      Button(GitHubSettingsSections.text("authorizeInWeb")) {
        Task { await UIApplication.shared.open(GitHubSettingsSections.authorizationURL) }
      }
      Button(String(localized: "common.cancel", bundle: .lody), role: .cancel) {}
    } message: {
      Text(GitHubSettingsSections.text("authorizationHint"))
    }
  }

  private var search: some View {
    HStack(spacing: LodySpacing.sm) {
      LodyIcon.search.image.resizable().renderingMode(.template)
        .frame(width: LodyIconSize.sm, height: LodyIconSize.sm)
        .foregroundStyle(LodyColor.iconTertiary)
      TextField(String(localized: "projects.github.search", bundle: .lody), text: $model.query)
        .lodyTextStyle(.body)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.search)
    }
    .padding(.horizontal, LodySpacing.md)
    .frame(minHeight: LodySize.controlMd)
    .background(LodyColor.fillSecondary, in: Capsule())
    .padding(.horizontal, LodyLayout.screenPaddingX)
    .padding(.vertical, LodySpacing.sm)
  }

  private var list: some View {
    ScrollView {
      LazyVStack(spacing: 0) {
        ForEach(model.repositories, id: \.repoFullName) { repo in
          row(repo)
          Divider().padding(.leading, LodyLayout.screenPaddingX + LodySize.avatarMd + LodySpacing.md)
        }
        footer
      }
    }
    .scrollDismissesKeyboard(.immediately)
  }

  private func row(_ repo: GitHubRepository) -> some View {
    Button { model.add(repo) } label: {
      HStack(spacing: LodySpacing.md) {
        RepositoryIcon(repository: repo.repoFullName, size: LodySize.avatarMd, opacity: 0.8)
        VStack(alignment: .leading, spacing: 2) {
          Text(repo.repoFullName)
            .lodyTextStyle(.body)
            .foregroundStyle(repo.enabled || !model.canManage ? LodyColor.textSecondary : LodyColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.middle)
          if repo.private {
            Text(String(localized: "projects.github.private", bundle: .lody))
              .lodyTextStyle(.footnote)
              .foregroundStyle(LodyColor.textTertiary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if model.adding == repo.repoFullName {
          ProgressView().controlSize(.small)
        } else if repo.enabled {
          Text(String(localized: "projects.github.added", bundle: .lody))
            .lodyTextStyle(.footnote)
            .foregroundStyle(LodyColor.textTertiary)
        } else if model.canManage {
          LodyIcon.plus.image.resizable().renderingMode(.template)
            .frame(width: LodyIconSize.sm, height: LodyIconSize.sm)
            .foregroundStyle(LodyColor.accentFg)
        }
      }
      .padding(.horizontal, LodyLayout.screenPaddingX)
      .frame(minHeight: LodySize.listRowTwoLine)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(repo.enabled || !model.canManage || model.adding != nil)
    .accessibilityIdentifier("github-repo:" + repo.repoFullName)
  }

  /// Errors, why a member can only look, and the way to reach repositories not listed.
  private var footer: some View {
    VStack(alignment: .leading, spacing: LodySpacing.sm) {
      if let error = model.error {
        Text(error).lodyTextStyle(.footnote).foregroundStyle(LodyColor.dangerDefault)
      }
      if !model.canManage {
        Text(String(localized: "projects.github.memberNote", bundle: .lody))
          .lodyTextStyle(.footnote).foregroundStyle(LodyColor.textTertiary)
      } else {
        Text(String(localized: "projects.github.missing", bundle: .lody))
          .lodyTextStyle(.footnote).foregroundStyle(LodyColor.textTertiary)
        installButton
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, LodyLayout.screenPaddingX)
    .padding(.vertical, LodySpacing.lg)
  }

  private var installButton: some View {
    Button { model.install() } label: {
      Label(String(localized: "projects.github.install", bundle: .lody), systemImage: "arrow.up.forward.app")
        .lodyTextStyle(.subhead)
    }
    .buttonStyle(.glass)
    .accessibilityIdentifier("github-install")
  }

  private func message(_ text: String, @ViewBuilder action: () -> some View) -> some View {
    VStack(spacing: LodySpacing.lg) {
      Spacer()
      Text(text)
        .lodyTextStyle(.body)
        .foregroundStyle(LodyColor.textSecondary)
        .multilineTextAlignment(.center)
      action()
      Spacer()
    }
    .padding(.horizontal, LodySpacing.xl)
    .frame(maxWidth: .infinity)
  }
}
