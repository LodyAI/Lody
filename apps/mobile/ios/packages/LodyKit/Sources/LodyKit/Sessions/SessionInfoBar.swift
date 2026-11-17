import Foundation

struct SessionPullRequestUpdates {
  private var confirmed: [String: String] = [:]
  /// Merge states read straight from GitHub after Ready for review, until the catalog has one.
  private var merges: [String: String] = [:]
  /// The write in flight. Its PR keeps the catalog's status until GitHub acknowledges it; the
  /// action bar shows progress meanwhile instead of claiming a merge that may still fail.
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

  /// A draft has no merge state, and the computer's poller may not refresh the PR for minutes,
  /// so the merge state GitHub computes after Ready for review is read directly (web
  /// `useGitHubPrDetails` does the same) and held until the catalog reports one of its own.
  mutating func observeMerge(_ pr: SessionPullRequest, merge: String) {
    guard ["c", "b", "d", "h", "u"].contains(merge) else { return }
    merges[key(pr)] = merge
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
    result.pullRequests = result.pullRequests.map { pr in
      let id = key(pr)
      guard let merge = merges[id] else { return pr }
      // The catalog's own state wins once it has one; a closed, merged or re-drafted PR drops it.
      guard pr.merge == nil, pr.status == "open" else {
        merges.removeValue(forKey: id)
        return pr
      }
      var updated = pr
      updated.merge = merge
      return updated
    }
    return result
  }
}

/// Reads GitHub's merge state after Ready for review. GitHub computes it in the background
/// (`unknown` meanwhile), so a few spaced reads replace waiting on the computer's PR poller.
/// Bounded; a failed read ends it quietly, since the catalog still converges on its own.
enum PullRequestMergeSettle {
  static let attempts = 15
  static let interval: Duration = .seconds(2)

  /// GitHub REST `mergeable_state` mapped like the CLI poller's `mapMergeState`; nil while pending.
  static func code(state: String?, mergeable: Bool?, draft: Bool) -> String? {
    guard !draft else { return nil }
    let known = ["clean": "c", "blocked": "b", "dirty": "d", "behind": "h", "unstable": "u", "has_hooks": "u"]
    if let state, let code = known[state] { return code }
    return mergeable == false ? "d" : nil
  }

  static func run(isolation: isolated (any Actor)? = #isolation, attempts: Int = attempts, read: () async throws -> String?, sleep: () async throws -> Void) async -> String? {
    for attempt in 0..<attempts {
      do {
        if attempt > 0 { try await sleep() }
        if let code = try await read() { return code }
      } catch { return nil }
    }
    return nil
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
  var files: Int?
  /// Priority order: the first is the bar's one text button, the rest hang off its menu.
  var actions: [Action] = []

  /// A Project group conversation: the context lists every member with its own PR instead
  /// of one repository, and the actions apply to the whole group.
  var group: SessionProjectRun?

  init(session: SessionItem, repository: String, busy: Bool) {
    added = session.diff["add"] ?? 0
    removed = session.diff["del"] ?? 0
    files = session.diff["files"]
    if let run = session.projectRun, !run.members.isEmpty {
      group = run
      actions = busy ? [] : Self.groupActions(session: session, run: run)
      return
    }
    self.repository = repository
    branch = session.branchName ?? ""
    // The machine appends associations; the last one for this repository is the current PR
    // (web `selectPrimarySessionPullRequest`).
    pullRequest = repository.isEmpty
      ? nil : session.pullRequests.last { $0.repository.lowercased() == repository.lowercased() }
    actions = Self.actions(session: session, pullRequest: pullRequest, repository: repository, busy: busy)
  }

  var hasDiff: Bool { files.map { $0 > 0 } ?? (added + removed > 0) }

  var hasContext: Bool { group != nil || !repository.isEmpty || !branch.isEmpty || hasDiff || pullRequest != nil }

  static func hasChanges(_ diff: [String: Int]) -> Bool {
    if let files = diff["files"] { return files > 0 }
    return (diff["add"] ?? 0) + (diff["del"] ?? 0) > 0
  }

  /// Web keeps Create PR and Commit & Push conversation-wide for a group (scoped by
  /// `withProjectGroupPrScope`); PR-bound actions (merge, ready, CI, conflicts) belong to one
  /// member's PR and are reached from that member's PR page.
  static func groupActions(session: SessionItem, run: SessionProjectRun) -> [Action] {
    let unpublished = session.workspaceDirty || session.workspaceUnpushed
      || run.members.contains { $0.dirty == true || $0.unpushed == true }
    let reported = run.members.contains { $0.diff != nil || $0.dirty != nil || $0.unpushed != nil }
    // A changed repository without an open PR still needs one. Members used in place have no PR.
    let needsPullRequest = reported
      ? run.members.contains { member in
        guard !member.inPlace, member.repoFullName != nil else { return false }
        let open = member.pullRequest.map { ["open", "draft"].contains($0.status) } ?? false
        let changed = (member.diff.map { $0.files.map { $0 > 0 } ?? ($0.add + $0.del > 0) } ?? false) || member.dirty == true || member.unpushed == true
        return changed && !open
      }
      : run.pullRequests.isEmpty && (unpublished || hasChanges(session.diff))
    let create: [Action] = needsPullRequest ? [.createPr, .createDraftPr] : []
    let commit: [Action] = unpublished ? [.commitAndPush] : []
    // Without any PR, creating one leads as for a single repository; once PRs exist,
    // unpublished work outranks opening the remaining ones.
    return run.pullRequests.isEmpty ? create + commit : commit + create
  }

  static func actions(session: SessionItem, pullRequest: SessionPullRequest?, repository: String, busy: Bool) -> [Action] {
    guard !repository.isEmpty, !busy else { return [] }
    let dirty = session.workspaceDirty
    guard let pullRequest else {
      // Create PR needs anything to base a PR on, committed or not; Commit & Push needs uncommitted work.
      let changed = dirty || hasChanges(session.diff)
      return (changed ? [.createPr, .createDraftPr] : []) + (dirty ? [.commitAndPush] : [])
    }
    if ["merged", "closed"].contains(pullRequest.status) { return [] }
    // Unpublished work outranks everything: the PR head is not the author's latest work.
    var actions: [Action] = dirty || session.workspaceUnpushed ? [.commitAndPush] : []
    // A draft has no merge gate to clear; readiness is the user's call.
    if pullRequest.status == "draft" { return actions + [.readyForReview] }
    if pullRequest.merge == "d" { actions.append(.resolveConflicts) }
    if ["f", "e"].contains(pullRequest.ci ?? "") { actions.append(.fixCi) }
    // Web `resolveSessionInfoBarGitHubActionIds`: Merge whenever GitHub would accept it, clean or
    // unstable (checks running or failing but not required). A demoted merge stays in the menu.
    if ["c", "u"].contains(pullRequest.merge) { actions.append(.merge) }
    return actions
  }

  static func title(_ action: Action) -> String {
    String(localized: String.LocalizationValue("bar.action." + action.rawValue), bundle: .lody)
  }

  /// The turn an action sends: web's localized quick-action prompts.
  func prompt(_ action: Action) -> String {
    func text(_ key: String) -> String { String(localized: String.LocalizationValue("bar.prompt." + key), bundle: .lody) }
    let upkeep = text("prBranchUpkeep")
    // Web `withProjectGroupPrScope`: a group conversation publishes every changed member.
    let scoped = { (prompt: String) in group == nil ? prompt : prompt + "\n\n" + Self.projectGroupScope }
    switch action {
    case .createPr:
      return text("createPrOrigin") + "\n\n" + scoped(text("createPr") + "\n\n" + upkeep)
    case .createDraftPr:
      return text("createDraftPrOrigin") + "\n\n" + scoped(text("createDraftPr") + "\n\n" + upkeep)
    case .commitAndPush:
      return scoped(text("commitAndPush"))
    case .resolveConflicts:
      guard let pullRequest else { return "" }
      return String(format: text("resolveConflicts"), repository, "#\(pullRequest.number)", pullRequestURL)
    case .fixCi:
      guard let pullRequest else { return "" }
      return String(format: text("fixCi"), repository, "#\(pullRequest.number)", pullRequestURL)
    case .readyForReview, .merge:
      return ""
    }
  }

  /// Web `withProjectGroupPrScope` (`packages/shared/src/pr-prompts.ts`), which web sends
  /// untranslated: it instructs the agent rather than reading back to the user.
  static let projectGroupScope = [
    "This conversation is a Project group: its directory is not a Git repository, and its member repositories are listed in this conversation.",
    "The request applies to each member repository with changes or unpublished commits.",
  ].joined(separator: " ")

  var pullRequestURL: String {
    guard let pullRequest else { return "" }
    return pullRequest.url ?? "https://github.com/\(pullRequest.repository)/pull/\(pullRequest.number)"
  }
}
