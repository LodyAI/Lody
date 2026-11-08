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
    }
    let session = githubUpdates.apply(session)
    let project = state.catalog.projects.first { $0.id == session.projectId }
    let repository = project?.repoFullName ?? (session.projectId.hasPrefix("github:") ? String(session.projectId.dropFirst(7)) : "")
    let bar = SessionInfoBar(session: session, repository: repository, busy: busy)
    infoBar = bar
    var result: [String: Any] = [:]
    result["items"] = resourceItems
    if let context = contextItem(bar, projectName: project?.name) { result["context"] = context }
    if bar.added + bar.removed > 0 {
      result["diff"] = [
        "added": bar.added, "removed": bar.removed, "tap": reviewable,
        "accessibilityLabel": "\(String(localized: "workspaceChanges.title", bundle: .lody)), +\(bar.added) −\(bar.removed)",
      ]
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
    if githubOperation != nil && (id == "act" || id.hasPrefix("more:")) { return }
    let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
    if ["browser", "simulator"].contains(parts[0]) { resourceAction(parts[0], parts.count > 1 ? parts[1] : "open"); return }
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
      UIPasteboard.general.string = bar.branch
      LodyToastOverlay.shared.show(message: String(localized: "session.title.branchCopied", bundle: .lody), kind: "info")
    default:
      if id.hasPrefix("more:"), let action = SessionInfoBar.Action(rawValue: String(id.dropFirst(5))) { performInfoBarAction(action) }
    }
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
    let preferred = UserDefaults.standard.string(forKey: Self.mergeMethodKey) ?? "merge"
    let anchor = chat.composer.primaryActionAnchor
    let sheet = MergeOptionsController(
      title: "\(pr.repository) #\(pr.number)", preferred: preferred,
      source: anchor.view, rect: anchor.rect
    ) { [weak self] method in
      UserDefaults.standard.set(method, forKey: Self.mergeMethodKey)
      self?.writePullRequest("merge", method: method)
    }
    present(sheet, animated: true)
  }

  private static let mergeMethodKey = "lody.prMergeMethod"

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
    let pending = operation == "merge" ? "bar.merge.pending" : "bar.ready.pending"
    LodyToastOverlay.shared.show(message: String(localized: String.LocalizationValue(pending), bundle: .lody), kind: "info")
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
        let done = operation == "merge" ? "bar.merge.done" : "bar.ready.done"
        LodyToastOverlay.shared.show(message: String(localized: String.LocalizationValue(done), bundle: .lody), kind: "success")
      } catch {
        guard let self, self.source.state.key == state.key else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        LodyToastOverlay.shared.show(message: Self.writeError(error, operation: operation), kind: "error")
      }
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
