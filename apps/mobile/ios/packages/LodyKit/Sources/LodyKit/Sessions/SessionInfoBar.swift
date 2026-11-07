import Foundation

struct SessionPullRequestUpdates {
  private var confirmed: [String: String] = [:]
  private var pending: (pr: SessionPullRequest, merged: Bool)?
  mutating func begin(_ pr: SessionPullRequest, merged: Bool) { pending = (pr, merged) }
  mutating func finish(success: Bool) {
    if success, let pending { confirm(pending.pr, merged: pending.merged) }
    pending = nil
  }
  private func key(_ pr: SessionPullRequest) -> String { "\(pr.repository.lowercased())#\(pr.number)" }

  /// Only called after GitHub acknowledges the write; retain it across stale catalog frames.
  mutating func confirm(_ pr: SessionPullRequest, merged: Bool) {
    confirmed[key(pr)] = merged ? "merged" : "open"
  }

  mutating func apply(_ session: SessionItem) -> SessionItem {
    var result = session
    result.pullRequests = session.pullRequests.map { pr in
      let id = key(pr)
      guard let status = confirmed[id] else { return pr }
      if pr.status == status || (status == "open" && pr.status != "draft") {
        confirmed.removeValue(forKey: id)
        return pr
      }
      var updated = pr
      updated.status = status
      return updated
    }
    if let pending {
      result.pullRequests = result.pullRequests.map { pr in
        guard key(pr) == key(pending.pr), pending.merged || pr.status == "draft" else { return pr }
        var updated = pr
        updated.status = pending.merged ? "merged" : "open"
        return updated
      }
    }
    return result
  }
}

/// Web `SessionInfoBar` (the action bar above the composer), reduced to what the catalog carries:
/// the session's computer, its repository context (PR, CI, branch, ±diff) and the repository
/// actions, ranked like `resolveSessionInfoBarGitHubActionIds`. Merge and Ready for review run
/// directly against GitHub with the workspace's brokered write grant (`GitHubPullRequests`); the
/// rest send an agent prompt. Goal and schedule stay on web: the catalog carries neither.
struct SessionInfoBar: Equatable {
  enum Action: String, CaseIterable {
    case createPr = "create-pr"
    case createDraftPr = "create-draft-pr"
    case commitAndPush = "commit-and-push"
    case resolveConflicts = "resolve-conflicts"
    case fixCi = "fix-ci-errors"
    case readyForReview = "ready-for-review"
    case merge

    /// Direct GitHub writes rather than agent prompts.
    var direct: Bool { self == .merge || self == .readyForReview }
  }

  var repository = ""
  var branch = ""
  var pullRequest: SessionPullRequest?
  var added = 0
  var removed = 0
  /// Priority order: the first is the bar's one text button, the rest hang off its menu.
  var actions: [Action] = []

  init(session: SessionItem, repository: String, busy: Bool) {
    self.repository = repository
    branch = session.branchName ?? ""
    // The machine appends associations, so the last is the current PR (web `getLatestPullRequest`).
    pullRequest = repository.isEmpty ? nil : session.pullRequests.last
    added = session.diff["add"] ?? 0
    removed = session.diff["del"] ?? 0
    actions = Self.actions(session: session, pullRequest: pullRequest, repository: repository, busy: busy)
  }

  var hasContext: Bool { !repository.isEmpty || !branch.isEmpty || added + removed > 0 || pullRequest != nil }

  static func actions(session: SessionItem, pullRequest: SessionPullRequest?, repository: String, busy: Bool) -> [Action] {
    guard !repository.isEmpty, !busy else { return [] }
    let dirty = session.workspaceDirty
    guard let pullRequest else {
      // Create PR needs anything to base a PR on, committed or not; Commit & Push needs uncommitted work.
      let changed = dirty || (session.diff["add"] ?? 0) + (session.diff["del"] ?? 0) > 0
      return (changed ? [.createPr, .createDraftPr] : []) + (dirty ? [.commitAndPush] : [])
    }
    if ["merged", "closed"].contains(pullRequest.status) { return [] }
    // Unpublished work outranks everything: the PR head is not the author's latest work.
    var actions: [Action] = dirty || session.workspaceUnpushed ? [.commitAndPush] : []
    // A draft has no merge gate to clear; readiness is the user's call.
    if pullRequest.status == "draft" { return actions + [.readyForReview] }
    if pullRequest.merge == "d" { actions.append(.resolveConflicts) }
    if ["f", "e"].contains(pullRequest.ci ?? "") { actions.append(.fixCi) }
    // Web `deriveSessionPullRequestReadiness`: GitHub reports clean, CI passed or absent. A demoted
    // merge stays in the menu so readiness is reachable on sessions that rank Commit & Push first.
    if pullRequest.merge == "c" && [nil, "s"].contains(pullRequest.ci) { actions.append(.merge) }
    return actions
  }

  static func title(_ action: Action) -> String {
    String(localized: String.LocalizationValue("bar.action." + action.rawValue), bundle: .lody)
  }

  /// The turn an action sends: web's localized quick-action prompts.
  func prompt(_ action: Action) -> String {
    func text(_ key: String) -> String { String(localized: String.LocalizationValue("bar.prompt." + key), bundle: .lody) }
    let upkeep = text("prBranchUpkeep")
    switch action {
    case .createPr:
      return text("createPrOrigin") + "\n\n" + text("createPr") + "\n\n" + upkeep
    case .createDraftPr:
      return text("createDraftPrOrigin") + "\n\n" + text("createDraftPr") + "\n\n" + upkeep
    case .commitAndPush:
      return text("commitAndPush")
    case .resolveConflicts:
      guard let pullRequest else { return "" }
      return String(format: text("resolveConflicts"), repository, "#\(pullRequest.number)", pullRequestURL)
    case .fixCi:
      guard let pullRequest else { return "" }
      return String(format: text("fixCi"), repository, pullRequest.number, pullRequestURL, branch.isEmpty ? "-" : branch)
    case .readyForReview, .merge:
      return ""
    }
  }

  var pullRequestURL: String {
    guard let pullRequest else { return "" }
    return pullRequest.url ?? "https://github.com/\(pullRequest.repository)/pull/\(pullRequest.number)"
  }
}
