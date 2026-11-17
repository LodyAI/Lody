import UIKit

/// The action bar above the composer (web `SessionInfoBar`): grouped glass capsules
/// (`ChatActionBarView`) built from `actionBarState`. Environment: the computer (menu: name and
/// presence) and live resources (browser preview, simulator). Context: PR or branch with the
/// ±diff (menu: workspace changes, the native PR page, copy branch). Action: the top repository
/// action with the rest behind its chevron. Prompt actions send web's quick-action prompt as an
/// ordinary turn; Merge (after a native method sheet that doubles as confirmation) and Ready for
/// review write to GitHub directly.
extension SessionController {
  func actionBarState(_ session: SessionItem, busy: Bool) -> [String: Any] {
    let state = source.state
    if githubScope != state.key {
      githubScope = state.key
      githubUpdates = SessionPullRequestUpdates()
      githubOperation = nil
      githubSettle?.cancel()
      githubSettle = nil
    }
    let session = githubUpdates.apply(session)
    let project = state.catalog.projects.first { $0.id == session.projectId }
    let repository = project?.repoFullName ?? (session.projectId.hasPrefix("github:") ? String(session.projectId.dropFirst(7)) : "")
    let bar = SessionInfoBar(session: session, repository: repository, busy: busy)
    infoBar = bar
    var result: [String: Any] = [:]
    var items = resourceItems
    let relations = SessionRelations.tree(sessions: state.catalog.sessions, current: sessionId)
    if relations.hasRelations {
      items.append(["id": "relations", "symbol": "bubble.left.and.bubble.right", "tap": true,
        "accessibilityLabel": String(localized: "session.relations.title", bundle: .lody)])
    }
    result["items"] = items
    if let run = bar.group {
      result["context"] = groupContextItem(run)
    } else if let context = contextItem(bar, projectName: project?.name) {
      result["context"] = context
    }
    if bar.hasDiff {
      let summary = bar.added + bar.removed > 0
        ? "+\(bar.added) −\(bar.removed)"
        : String.localizedStringWithFormat(String(localized: "changes.fileCount", bundle: .lody), bar.files ?? 0)
      var diff: [String: Any] = [
        "added": bar.added, "removed": bar.removed, "tap": reviewable,
        "accessibilityLabel": "\(String(localized: "workspaceChanges.title", bundle: .lody)), \(summary)",
      ]
      if let files = bar.files { diff["files"] = files }
      result["diff"] = diff
    }
    if let first = bar.actions.first {
      result["primary"] = [
        "label": SessionInfoBar.title(first),
        "disclosure": first == .merge,
        "moreLabel": String(localized: "bar.more", bundle: .lody),
        "more": bar.actions.dropFirst().map { ["id": $0.rawValue, "title": SessionInfoBar.title($0), "symbol": Self.symbol($0)] },
      ]
    }
    if let operation = githubOperation {
      let pending = operation == "merge" ? "bar.merge.pending" : "bar.ready.pending"
      result["primary"] = [
        "label": String(localized: String.LocalizationValue(pending), bundle: .lody),
        "busy": true, "more": [], "moreLabel": "",
      ]
    }
    return result
  }

  /// PR number, else branch, else the repository name without its owner (web truncated the
  /// owner first; on a phone it carries nothing). CI trouble tints the PR glyph instead of text.
  private func contextItem(_ bar: SessionInfoBar, projectName: String?) -> [String: Any]? {
    guard !bar.repository.isEmpty || !bar.branch.isEmpty || bar.pullRequest != nil else { return nil }
    let name = bar.repository.split(separator: "/").last.map(String.init) ?? bar.repository
    var label = bar.branch.isEmpty ? name : bar.branch
    var symbol = "arrow.triangle.branch"
    var tint = "secondary"
    var actions: [[String: Any]] = []
    var description = [bar.repository, bar.branch]
    if let pr = bar.pullRequest {
      label = "#\(pr.number)"
      symbol = pr.status == "merged" ? "arrow.triangle.merge" : "arrow.triangle.pull"
      tint = pr.status
      var subtitle = String(localized: String.LocalizationValue("pr.state." + pr.status), bundle: .lody)
      if let ci = pr.ci, ["s", "f", "e", "p", "x"].contains(ci) {
        let key = ci == "x" ? "home.ci.expected" : "bar.ci." + ci
        subtitle += " · " + String(localized: String.LocalizationValue(key), bundle: .lody)
      }
      if pr.merge == "d" { subtitle += " · " + String(localized: "bar.conflicts", bundle: .lody) }
      actions.append(["id": "pr", "title": String(localized: "bar.context.viewPR", bundle: .lody), "value": "#\(pr.number)", "subtitle": subtitle, "symbol": symbol])
      description += [label, subtitle]
    }
    if !bar.branch.isEmpty {
      actions.append(["id": "branch", "title": bar.branch, "symbol": "doc.on.doc"])
    }
    return [
      "label": label, "symbol": symbol, "tint": tint, "actions": actions,
      "accessibilityLabel": description.filter { !$0.isEmpty }.joined(separator: ", "),
      "menuTitle": bar.repository.isEmpty ? (projectName ?? "") : bar.repository,
      "repository": bar.repository,
      "prStatus": bar.pullRequest?.status ?? "", "prCI": bar.pullRequest?.ci ?? "",
      // A PR write in flight: the mark spins until GitHub answers, then shows the real status.
      "busy": bar.pullRequest != nil && githubOperation != nil,
    ]
  }

  /// A Project group: the capsule summarises the repositories and their PRs; its popover lists
  /// every member with its own branch, ±diff and PR (web's Repositories chip, without a hidden
  /// selected member). A PR row opens that PR's page, which carries its PR-bound actions.
  private func groupContextItem(_ run: SessionProjectRun) -> [String: Any] {
    let repositories = String.localizedStringWithFormat(String(localized: "bar.group.repositories", bundle: .lody), run.members.count)
    let pullRequests = run.pullRequests
    let prs = String.localizedStringWithFormat(String(localized: "bar.group.pullRequests", bundle: .lody), pullRequests.count)
    let label = pullRequests.isEmpty ? repositories : repositories + " · " + prs
    // A failing check anywhere is the one thing worth colour on the capsule.
    let failing = pullRequests.contains { ["open", "draft"].contains($0.status) && ["f", "e"].contains($0.ci ?? "") }
    let members: [[String: Any]] = run.members.map { member in
      var row: [String: Any] = [
        "id": member.id, "title": member.identity, "kind": member.kind, "depth": member.depth, "submodule": member.submodule,
      ]
      var detail: [String] = []
      if member.path != member.identity { detail.append(member.path) }
      if member.inPlace {
        detail.append(String(localized: "bar.group.inPlace", bundle: .lody))
      } else if let branch = member.branch {
        detail.append(branch)
        row["branch"] = branch
      }
      row["detail"] = detail.joined(separator: " · ")
      if let repository = member.repoFullName { row["repository"] = repository }
      if let diff = member.diff { row["added"] = diff.add; row["removed"] = diff.del }
      if let pr = member.pullRequest {
        row["prNumber"] = pr.number
        row["prStatus"] = pr.status
        if let ci = pr.ci { row["prCI"] = ci }
      }
      return row
    }
    var description = [run.name, repositories]
    if !pullRequests.isEmpty { description.append(prs) }
    return [
      "label": label, "symbol": "square.stack", "tint": failing ? "danger" : "secondary", "actions": [] as [[String: Any]],
      "accessibilityLabel": description.filter { !$0.isEmpty }.joined(separator: ", "),
      "menuTitle": run.name,
      "menuSubtitle": String.localizedStringWithFormat(String(localized: "create.context.groupMembers", bundle: .lody), run.members.count)
        + (pullRequests.isEmpty ? "" : " · " + prs),
      "members": members,
    ]
  }

  private static func symbol(_ action: SessionInfoBar.Action) -> String {
    switch action {
    case .createPr: "arrow.triangle.pull"
    case .createDraftPr: "pencil.and.outline"
    case .commitAndPush: "arrow.up.circle"
    case .resolveConflicts: "arrow.triangle.merge"
    case .fixCi: "wrench.and.screwdriver"
    case .readyForReview: "eye"
    case .merge: "arrow.triangle.merge"
    }
  }

  /// `item` or `item:menuAction`, from the action bar.
  func infoBarAction(_ id: String) {
    if id == "relations" { presentRelations(); return }
    if githubOperation != nil && (id == "act" || id.hasPrefix("more:")) { return }
    let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
    if ["browser", "simulator", "emulator"].contains(parts[0]) { resourceAction(parts[0], parts.count > 1 ? parts[1] : "open"); return }
    guard let bar = infoBar else { return }
    switch id {
    case "diff", "context:diff":
      openWorkspaceChanges()
    case "act":
      if let first = bar.actions.first { performInfoBarAction(first) }
    case "context:pr":
      if let pr = bar.pullRequest { openPullRequest(pr) }
    case "context:branch":
      guard !bar.branch.isEmpty else { return }
      copyBranch(bar.branch)
    default:
      if id.hasPrefix("context:member:"), let member = groupMember(id, prefix: "context:member:") {
        if let pr = member.pullRequest { openPullRequest(pr) }
        return
      }
      if id.hasPrefix("context:memberBranch:"), let branch = groupMember(id, prefix: "context:memberBranch:")?.branch {
        copyBranch(branch)
        return
      }
      if id.hasPrefix("more:"), let action = SessionInfoBar.Action(rawValue: String(id.dropFirst(5))) { performInfoBarAction(action) }
    }
  }

  private func groupMember(_ id: String, prefix: String) -> SessionProjectMember? {
    let memberId = String(id.dropFirst(prefix.count))
    return infoBar?.group?.members.first { $0.id == memberId }
  }

  private func copyBranch(_ branch: String) {
    UIPasteboard.general.string = branch
    LodyToastOverlay.shared.show(message: String(localized: "session.title.branchCopied", bundle: .lody), kind: .neutral)
  }

  private func performInfoBarAction(_ action: SessionInfoBar.Action) {
    switch action {
    case .merge: chooseMergeMethod()
    case .readyForReview: writePullRequest("ready")
    default: sendInfoBarPrompt(action)
    }
  }

  /// Merging cannot be undone, so the method sheet is also the confirmation. The last method
  /// chosen leads (web `usePreferredPrMergeMethod`, default merge commit).
  private func chooseMergeMethod() {
    guard let pr = infoBar?.pullRequest else { return }
    let anchor = chat.composer.primaryActionAnchor
    let sheet = MergeOptionsController(
      title: "\(pr.repository) #\(pr.number)", preferred: MergeOptionsController.preferred,
      source: anchor.view, rect: anchor.rect
    ) { [weak self] method in
      self?.writePullRequest("merge", method: method)
    }
    present(sheet, animated: true)
  }

  /// One GitHub write at a time, scoped to the account and workspace that started it. Never
  /// retried: an unknown result says so instead of claiming failure.
  private func writePullRequest(_ operation: String, method: String? = nil) {
    guard githubOperation == nil, let pr = infoBar?.pullRequest else { return }
    let state = source.state
    githubOperation = operation
    githubUpdates.begin(pr, merged: operation == "merge")
    renderComposer()
    var payload: [String: Any] = ["workspaceId": state.workspaceId, "repository": pr.repository, "number": pr.number, "operation": operation]
    if let method { payload["method"] = method }
    if operation == "merge" {
      LodyToastOverlay.shared.show(message: String(localized: "bar.merge.pending", bundle: .lody), kind: .neutral)
    }
    Task { @MainActor [weak self] in
      defer {
        if let self, self.source.state.key == state.key {
          self.githubOperation = nil
          self.githubUpdates.finish(success: false)
          self.renderComposer()
        }
      }
      do {
        _ = try await GitHubPullRequests.run(Self.json(payload))
        guard let self, self.source.state.key == state.key else { return }
        self.githubUpdates.finish(success: true)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        if operation == "merge" {
          LodyToastOverlay.shared.show(message: String(localized: "bar.merge.done", bundle: .lody), kind: .neutral)
        } else {
          self.settleMergeState(pr, workspaceId: state.workspaceId, scope: state.key)
        }
      } catch {
        guard let self, self.source.state.key == state.key else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        LodyToastOverlay.shared.show(message: Self.writeError(error, operation: operation), kind: .error)
      }
    }
  }

  /// After Ready for review, read GitHub's merge state directly so Merge appears as soon as
  /// GitHub has computed it, instead of when the computer's PR poller next refreshes the catalog.
  private func settleMergeState(_ pr: SessionPullRequest, workspaceId: String, scope: String) {
    githubSettle?.cancel()
    let payload = Self.json(["workspaceId": workspaceId, "repository": pr.repository, "number": pr.number, "operation": "mergeState"])
    githubSettle = Task { @MainActor [weak self] in
      let merge = await PullRequestMergeSettle.run(read: { [weak self] in
        guard let self, self.source.state.key == scope else { throw CancellationError() }
        let raw = try await GitHubPullRequests.run(payload)
        return (try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])?["merge"] as? String
      }, sleep: { try await Task.sleep(for: PullRequestMergeSettle.interval) })
      guard let self, let merge, !Task.isCancelled, self.source.state.key == scope else { return }
      self.githubUpdates.observeMerge(pr, merge: merge)
      self.renderComposer()
    }
  }

  private static func writeError(_ error: Error, operation: String) -> String {
    let known = ["not_mergeable", "head_changed", "authorization_required", "merge_unknown", "ready_unknown", "not_open", "forbidden"]
    let code = error.localizedDescription
    let key = known.contains(code) ? "bar.error." + code : (operation == "merge" ? "bar.merge.error" : "bar.ready.error")
    return String(localized: String.LocalizationValue(key), bundle: .lody)
  }

  /// Sent like a typed turn (pending bubble, outbox, no automatic replay); only while the action
  /// is still offered, so a stale menu cannot send for a state that moved on.
  private func sendInfoBarPrompt(_ action: SessionInfoBar.Action) {
    guard let bar = infoBar, bar.actions.contains(action) else { return }
    let text = bar.prompt(action)
    guard !text.isEmpty else { return }
    chat.composer.onSend?([
      "id": UUID().uuidString.lowercased(), "queue": false, "guide": false, "text": text,
      "startedAt": Date().timeIntervalSince1970 * 1000, "attachments": [] as [[String: Any]],
    ])
  }
}
