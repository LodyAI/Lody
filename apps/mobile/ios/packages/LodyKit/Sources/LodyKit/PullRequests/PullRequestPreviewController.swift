import UIKit

@MainActor
final class PullRequestPreviewController: PullRequestController {
  init(params: [String: Any]) {
    let fixture = PullRequestFixture(mode: params["mode"] as? String ?? "preview", state: params["state"] as? String ?? "open", reference: params["reference"] as? SessionPullRequest)
    let store = PullRequestStore(repository: fixture.data.repository, number: fixture.data.number,
      scope: SettingsActor(userId: "preview", workspaceId: "preview"), service: fixture.service)
    super.init(store: store)
    external = { [weak self] in self?.alert(String(localized: "pr.previewAction", bundle: .lody)) }
    investigate = { [weak self] text in
      guard let self else { throw PullRequestStore.failure("unavailable") }
      try await LodyShell.shared.callback(from: self, name: "onInvestigate", value: text)
    }
  }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

@MainActor
private final class PullRequestFixture {
  var data: PullRequestSnapshot
  let mode: String
  var reads = 0
  var writes = 0
  init(mode: String, state: String, reference: SessionPullRequest? = nil) {
    self.mode = mode
    var object = try! JSONSerialization.jsonObject(with: Data(Self.json.utf8)) as! [String: Any]
    if let reference {
      object["repository"] = reference.repository
      object["number"] = reference.number
      object["headRef"] = "feature/mobile-ui"
    }
    data = try! JSONDecoder().decode(PullRequestSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
    data.state = state
    if state == "open" { data.mergeState = "c" }
    if state == "merged" { data.branchExists = true }
    if mode == "empty" { data.checks = [] }
  }
  var service: PullRequestService {
    PullRequestService(read: { [self] in
      reads += 1
      if mode == "authorization", reads == 1 { throw PullRequestStore.failure("authorization_required") }
      return data
    }, comment: { [self] body in
      if mode == "preview" { return false }
      writes += 1
      if mode == "comment", writes == 1 { throw PullRequestStore.failure("forbidden") }
      data.comments = [.init(id: 1, author: "Preview", body: body, url: "")]
      return true
    }, merge: { [self] _ in
      if mode == "merge" { throw PullRequestStore.failure("not_mergeable") }
      data.state = "merged"; data.mergeState = nil; data.branchExists = true
    }, deleteBranch: { [self] in
      data.branchExists = false
    })
  }
  private static let json = #"""
  {"state": "open", "author": "Innei", "comments": [], "repository": "Innei/lody-ios", "number": 31, "title": "fix: automatically reconnect session stream reads", "body": "Session reads reconnect after temporary interruptions. Existing messages and read positions are retained with bounded backoff. Leaving a session cancels the wait. Writes and machine commands are never replayed.", "headRef": "fix/session-auto-reconnect", "baseRef": "main", "headSha": "ed40e8079", "additions": 229, "deletions": 16, "changedFiles": 4, "commits": 1, "checks": [{"id": 1, "name": "Checks", "status": "completed", "conclusion": "failure", "appName": "GitHub Actions", "htmlUrl": null}, {"id": 2, "name": "Native behavior", "status": "completed", "conclusion": "success", "appName": "GitHub Actions", "htmlUrl": null}, {"id": 3, "name": "Build iOS Simulator", "status": "completed", "conclusion": "success", "appName": "GitHub Actions", "htmlUrl": null}, {"id": 4, "name": "Offline iOS UI \u00b7 Pages", "status": "in_progress", "conclusion": null, "appName": "GitHub Actions", "htmlUrl": null}, {"id": 5, "name": "Offline iOS UI \u00b7 Chat", "status": "queued", "conclusion": null, "appName": "GitHub Actions", "htmlUrl": null}]}
  """#
}
