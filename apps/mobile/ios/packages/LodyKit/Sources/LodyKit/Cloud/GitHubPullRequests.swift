import Foundation

/// GitHub credentials never cross the native boundary. No automatic mutation retry.
@MainActor enum GitHubPullRequests {
  static func run(_ payload: String) async throws -> String {
    guard let bytes = payload.data(using: .utf8),
          let args = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let workspace = args["workspaceId"] as? String, !workspace.isEmpty,
          let repo = args["repository"] as? String,
          repo.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$"#, options: .regularExpression) != nil,
          ![".", ".."].contains(repo.components(separatedBy: "/").last ?? ""),
          let number = args["number"] as? Int, number > 0,
          let operation = args["operation"] as? String, ["read", "comment", "merge", "ready"].contains(operation)
    else { throw failure("invalid_request") }
    guard let credential = try AuthKeychain.read(), !credential.isEmpty else { throw failure("unauthorized") }
    let writing = operation != "read"
    let body = (args["body"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if operation == "comment" && (body.isEmpty || body.count > 65536) { throw failure("invalid_comment") }
    let auth = try await request("\(BackendEnvironment.site)/api/auth/convex/token", token: credential)
    guard let jwt = auth["token"] as? String else { throw failure("unauthorized") }
    try checkIdentity(credential)
    let broker = try await request("\(BackendEnvironment.convex)/api/action", token: jwt, body: [
      "path": "github:getOperationAccessTokenByRepoNameForClient", "format": "convex_encoded_json",
      "args": [["workspaceId": workspace, "repoFullName": repo, "operation": writing ? "write" : "read"]]
    ])
    try checkIdentity(credential)
    guard broker["status"] as? String == "success", let value = broker["value"] as? [String: Any],
          value["success"] as? Bool == true, let token = value["token"] as? String, !token.isEmpty
    else { throw failure("authorization_required") }
    let base = "https://api.github.com/repos/\(repo)"
    if operation == "merge" || operation == "ready" {
      return try await transition(operation, base: base, number: number, method: args["method"] as? String, token: token, credential: credential)
    }
    if writing {
      // A transport failure may follow a successful write. Never replay it.
      _ = try await request("\(base)/issues/\(number)/comments", token: token, body: ["body": body], mutation: true)
      try checkIdentity(credential)
      return "{}"
    }
    let pr = try await request("\(base)/pulls/\(number)", token: token)
    try checkIdentity(credential)
    guard let head = pr["head"] as? [String: Any], let sha = head["sha"] as? String,
          sha.range(of: #"^[0-9a-fA-F]{7,64}$"#, options: .regularExpression) != nil,
          let target = pr["base"] as? [String: Any]
    else { throw failure("invalid_response") }
    var state = pr["state"] as? String ?? "closed"
    if pr["merged"] as? Bool == true { state = "merged" }
    else if pr["draft"] as? Bool == true && state == "open" { state = "draft" }
    var result: [String: Any] = [
      "repository": repo, "number": number, "state": state,
      "title": pr["title"] as? String ?? "", "body": pr["body"] as? String ?? "",
      "author": (pr["user"] as? [String: Any])?["login"] as? String ?? "",
      "headRef": head["ref"] as? String ?? "", "baseRef": target["ref"] as? String ?? "", "headSha": sha,
      "additions": pr["additions"] as? Int ?? 0, "deletions": pr["deletions"] as? Int ?? 0,
      "changedFiles": pr["changed_files"] as? Int ?? 0, "commits": pr["commits"] as? Int ?? 0,
      "checks": [], "comments": []
    ]
    do {
      let checks = try await request("\(base)/commits/\(sha)/check-runs?per_page=100", token: token)
      guard let rows = checks["check_runs"] as? [[String: Any]] else { throw failure("invalid_response") }
      result["checks"] = rows.map { row in
        let status = row["status"] as? String ?? "queued"
        let conclusion = row["conclusion"] as? String ?? ""
        let known = ["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "stale", "skipped"].contains(conclusion)
        return [
        "id": row["id"] ?? 0, "name": row["name"] ?? "",
        "status": ["queued", "in_progress", "completed"].contains(status) ? status : "queued", "conclusion": known ? conclusion as Any : NSNull(),
        "htmlUrl": row["html_url"] ?? NSNull(),
        "appName": (row["app"] as? [String: Any])?["name"] ?? NSNull()
      ] }
      result["checksTruncated"] = (checks["total_count"] as? Int ?? 0) > rows.count
    } catch { result["checksError"] = code(error) }
    try checkIdentity(credential)
    do {
      let response = try await request("\(base)/issues/\(number)/comments?per_page=100", token: token)
      guard let rows = response["rows"] as? [[String: Any]] else { throw failure("invalid_response") }
      result["comments"] = rows.map { row in [
        "id": row["id"] ?? 0, "body": row["body"] as? String ?? "",
        "author": (row["user"] as? [String: Any])?["login"] as? String ?? "",
        "url": row["html_url"] as? String ?? ""
      ] }
      result["commentsTruncated"] = response["hasNext"] as? Bool ?? false
    } catch { result["commentsError"] = code(error) }
    try checkIdentity(credential)
    return String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
  }

  /// Web `useGitHubPrDetails` merge / ready for review, with the workspace's brokered write grant.
  /// Merge pins the head just read, so commits pushed meanwhile make GitHub refuse instead of
  /// landing unseen work. Neither is retried: a lost response may follow a completed change.
  private static func transition(_ operation: String, base: String, number: Int, method: String?, token: String, credential: String) async throws -> String {
    let pr = try await request("\(base)/pulls/\(number)", token: token)
    try checkIdentity(credential)
    guard pr["state"] as? String == "open", pr["merged"] as? Bool != true else { throw failure("not_open") }
    let draft = pr["draft"] as? Bool == true
    if operation == "merge" {
      guard let method, ["merge", "squash", "rebase"].contains(method) else { throw failure("invalid_request") }
      guard !draft else { throw failure("not_mergeable") }
      guard let sha = (pr["head"] as? [String: Any])?["sha"] as? String,
            sha.range(of: #"^[0-9a-fA-F]{7,64}$"#, options: .regularExpression) != nil
      else { throw failure("invalid_response") }
      let result = try await request("\(base)/pulls/\(number)/merge", token: token,
        body: ["merge_method": method, "sha": sha], method: "PUT", unknown: "merge_unknown")
      try checkIdentity(credential)
      guard result["merged"] as? Bool == true else { throw failure("not_mergeable") }
      return #"{"merged":true}"#
    }
    guard draft else { return #"{"ready":true}"# }
    guard let node = pr["node_id"] as? String, !node.isEmpty else { throw failure("invalid_response") }
    let result = try await request("https://api.github.com/graphql", token: token, body: [
      "query": "mutation MarkReady($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      "variables": ["id": node],
    ], unknown: "ready_unknown")
    try checkIdentity(credential)
    // GraphQL reports application errors with a 200.
    if let errors = result["errors"] as? [Any], !errors.isEmpty { throw failure("request_failed") }
    return #"{"ready":true}"#
  }

  private static func checkIdentity(_ credential: String) throws {
    guard try AuthKeychain.read() == credential else { throw failure("unauthorized") }
    try Task.checkCancellation()
  }
  private static func failure(_ code: String) -> NSError {
    NSError(domain: "LodyKit.GitHubPullRequests", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
  }
  private static func code(_ error: Error) -> String {
    let value = error as NSError
    return value.domain == "LodyKit.GitHubPullRequests" ? value.localizedDescription : "unavailable"
  }
  /// [unknown] marks a parsed write: its transport failure or 5xx is an unknown outcome, never "failed".
  private static func request(_ address: String, token: String, body: [String: Any]? = nil, mutation: Bool = false,
                              method: String = "POST", unknown: String? = nil) async throws -> [String: Any] {
    let unknownCode = unknown ?? (mutation ? "comment_unknown" : nil)
    var request = URLRequest(url: URL(string: address)!, timeoutInterval: 20)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    if address.hasPrefix("https://api.github.com/") { request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version") }
    if let body {
      request.httpMethod = method
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let data: Data
    let response: URLResponse
    do { (data, response) = try await URLSession.shared.data(for: request) }
    catch { throw failure(unknownCode ?? "unavailable") }
    guard let response = response as? HTTPURLResponse else { throw failure(unknownCode ?? "unavailable") }
    if response.statusCode == 401 { throw failure("unauthorized") }
    if response.statusCode == 403 { throw failure("forbidden") }
    if response.statusCode == 404 { throw failure("not_found") }
    if response.statusCode == 429 { throw failure("rate_limited") }
    // Merge: 405 not mergeable, 409 the head moved since it was read.
    if response.statusCode == 405 { throw failure("not_mergeable") }
    if response.statusCode == 409 { throw failure("head_changed") }
    guard (200..<300).contains(response.statusCode) else {
      if response.statusCode >= 500, let unknownCode { throw failure(unknownCode) }
      throw failure("request_failed")
    }
    if mutation { return [:] }
    guard data.count <= 8 * 1024 * 1024 else { throw failure("response_limit") }
    let value = try JSONSerialization.jsonObject(with: data)
    if let rows = value as? [[String: Any]] {
      return ["rows": rows, "hasNext": response.value(forHTTPHeaderField: "Link")?.contains("rel=\"next\"") == true]
    }
    guard let value = value as? [String: Any] else { throw failure("invalid_response") }
    return value
  }
}
