import Foundation

@MainActor final class SettingsActor {
  var key = "user:workspace"
  var valid = true
  var changed: (() -> Void)?
  func watch(_ owner: AnyObject, _ changed: @escaping () -> Void) { self.changed = changed }
}
enum GitHubPullRequests { static func run(_ payload: String) async throws -> String { fatalError("Unexpected network request") } }

@MainActor final class Harness {
  var reads: [CheckedContinuation<PullRequestSnapshot, Error>] = []
  var writes = 0
  var service: PullRequestService { .init(read: { [self] in
    try await withCheckedThrowingContinuation { reads.append($0) }
  }, comment: { [self] _ in writes += 1; return true }) }
  var snapshot: PullRequestSnapshot {
    .init(state: "open", author: "a", repository: "a/b", number: 1, title: "Title", body: "", headRef: "feature", baseRef: "main", headSha: "1234567", additions: 1, deletions: 0, changedFiles: 1, commits: 1, checks: [], comments: [])
  }
}

@main struct Check {
  @MainActor static func settle() async { for _ in 0..<40 { await Task.yield() } }
  @MainActor static func main() async {
    let io = Harness(), scope = SettingsActor()
    let store = PullRequestStore(repository: "a/b", number: 1, scope: scope, service: io.service)
    store.refresh(); store.refresh(); await settle()
    precondition(io.reads.count == 1, "Concurrent refresh must coalesce")
    io.reads[0].resume(returning: io.snapshot); await settle()
    precondition(store.data?.title == "Title" && !store.loading)
    store.refresh(); await settle()
    io.reads[1].resume(throwing: PullRequestStore.failure("forbidden")); await settle()
    precondition(store.data?.title == "Title" && store.error == "forbidden", "Failed refresh retains stale data with error")
    let accepted = try! await store.comment("hello")
    precondition(accepted && io.writes == 1)
    await settle()
    io.reads[2].resume(throwing: PullRequestStore.failure("unavailable")); await settle()
    precondition(io.writes == 1 && store.error == "unavailable", "Read failure cannot replay an accepted write")
    store.refresh(); await settle()
    scope.key = "other:workspace"; scope.changed?()
    io.reads[3].resume(returning: io.snapshot); await settle()
    precondition(store.data == nil && store.error == "unauthorized" && !store.loading, "Late data cannot cross account scope")
    do { _ = try await store.comment("blocked"); preconditionFailure("Scope changed write accepted") } catch {}
    precondition(io.writes == 1)
    var snapshot = io.snapshot
    precondition(snapshot.summary == "empty")
    for (status, conclusion, expected) in [("queued", nil, "active"), ("completed", "success", "passed"),
      ("completed", "failure", "failed"), ("completed", nil, "finished")] as [(String, String?, String)] {
      snapshot.checks = [.init(id: 1, name: "CI", status: status, conclusion: conclusion, htmlUrl: nil, appName: nil)]
      precondition(snapshot.summary == expected)
    }
    snapshot.checksTruncated = true
    precondition(snapshot.summary == "partial")
    snapshot.checksError = "forbidden"
    precondition(snapshot.summary == "unavailable")
    print("Pull request refresh, scope fencing, acknowledged write and partial checks passed")
  }
}
