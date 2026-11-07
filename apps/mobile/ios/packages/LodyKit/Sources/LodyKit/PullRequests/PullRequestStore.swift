import Foundation

struct PullRequestCheck: Codable, Equatable {
  let id: Int
  let name: String
  let status: String
  let conclusion: String?
  let htmlUrl: String?
  let appName: String?
  var state: String { status == "completed" ? conclusion ?? "unknown" : status }
  var failed: Bool { status == "completed" && ["failure", "timed_out", "action_required"].contains(conclusion ?? "") }
  var symbol: String {
    ["queued": "clock", "in_progress": "arrow.trianglehead.2.clockwise.rotate.90", "success": "checkmark.circle",
     "failure": "xmark.circle", "neutral": "minus.circle", "cancelled": "slash.circle", "timed_out": "clock.badge.exclamationmark",
     "action_required": "exclamationmark.circle", "stale": "clock", "skipped": "arrow.uturn.right.circle"][state] ?? "questionmark.circle"
  }
}

struct PullRequestSnapshot: Codable {
  struct Comment: Codable { let id: Int; let author: String; let body: String; let url: String }
  var state: String
  let author: String
  let repository: String
  let number: Int
  let title: String
  let body: String
  let headRef: String
  let baseRef: String
  let headSha: String
  let additions: Int
  let deletions: Int
  let changedFiles: Int
  let commits: Int
  var checks: [PullRequestCheck]
  var checksError: String?
  var checksTruncated: Bool?
  var comments: [Comment]
  var commentsError: String?
  var commentsTruncated: Bool?
  var summary: String {
    if checksError != nil { return "unavailable" }
    if checksTruncated == true { return "partial" }
    if checks.isEmpty { return "empty" }
    if checks.contains(where: \.failed) { return "failed" }
    if checks.contains(where: { $0.status != "completed" }) { return "active" }
    if checks.allSatisfy({ ["success", "neutral", "skipped"].contains($0.conclusion ?? "") }) { return "passed" }
    return "finished"
  }
}

struct PullRequestService {
  var read: @MainActor () async throws -> PullRequestSnapshot
  var comment: @MainActor (String) async throws -> Bool

  @MainActor static func live(workspaceId: String, repository: String, number: Int) -> Self {
    struct Request: Encodable {
      let workspaceId: String
      let repository: String
      let number: Int
      let operation: String
      let body: String?
    }
    func request(_ operation: String, body: String? = nil) async throws -> String {
      let payload = Request(workspaceId: workspaceId, repository: repository, number: number, operation: operation, body: body)
      return try await GitHubPullRequests.run(String(decoding: JSONEncoder().encode(payload), as: UTF8.self))
    }
    return Self(read: {
      let json = try await request("read")
      return try JSONDecoder().decode(PullRequestSnapshot.self, from: Data(json.utf8))
    }, comment: { body in
      _ = try await request("comment", body: body)
      return true
    })
  }
}

@MainActor
final class PullRequestStore {
  private struct Watcher { weak var owner: AnyObject?; let changed: () -> Void }
  let repository: String
  let number: Int
  let service: PullRequestService
  let scope: SettingsActor
  private let scopeKey: String
  private var watchers: [Watcher] = []
  private var task: Task<Void, Never>?
  private(set) var data: PullRequestSnapshot?
  private(set) var error: String?
  private(set) var loading = false
  private(set) var posting = false
  var valid: Bool { scope.valid && scope.key == scopeKey }
  var url: URL { URL(string: "https://github.com/\(repository)/pull/\(number)")! }

  init(repository: String, number: Int, scope: SettingsActor, service: PullRequestService) {
    self.repository = repository
    self.number = number
    self.scope = scope
    scopeKey = scope.key
    self.service = service
    scope.watch(self) { [weak self] in
      guard let self, !valid else { return }
      task?.cancel(); task = nil; data = nil; error = "unauthorized"; loading = false
      publish()
    }
  }

  isolated deinit { task?.cancel() }

  func watch(_ owner: AnyObject, changed: @escaping () -> Void) {
    watchers.append(Watcher(owner: owner, changed: changed))
  }

  private func publish() {
    watchers.removeAll { $0.owner == nil }
    for watcher in watchers { watcher.changed() }
  }

  func refresh() {
    guard valid, !loading else { return }
    loading = true; error = nil; publish()
    task = Task { [weak self, service] in
      do {
        let snapshot = try await service.read()
        guard !Task.isCancelled, let self, valid else { return }
        data = snapshot
      } catch {
        guard !Task.isCancelled, let self, valid else { return }
        self.error = error.localizedDescription
      }
      guard let self else { return }
      loading = false; task = nil; publish()
    }
  }

  func comment(_ body: String) async throws -> Bool {
    guard valid, !posting else { throw Self.failure("unauthorized") }
    posting = true
    defer { posting = false }
    let accepted = try await service.comment(body)
    guard valid else { throw Self.failure("unauthorized") }
    if accepted {
      // Finish the write independently; a failed refresh must never invite replay.
      if let task {
        Task { [weak self] in await task.value; self?.refresh() }
      } else { refresh() }
    }
    return accepted
  }

  static func failure(_ code: String) -> NSError {
    NSError(domain: "LodyKit.PullRequest", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
  }

  static func errorText(_ code: String) -> String {
    for (match, key) in [("comment_unknown", "commentUnknown"), ("unauthorized", "authorization"),
                         ("authorization_required", "authorization"), ("forbidden", "forbidden"),
                         ("not_found", "notFound"), ("rate_limited", "rateLimit")] where code.contains(match) {
      return String(localized: String.LocalizationValue("pr.error." + key), bundle: .lody)
    }
    return String(localized: "pr.error.unavailable", bundle: .lody)
  }
}
