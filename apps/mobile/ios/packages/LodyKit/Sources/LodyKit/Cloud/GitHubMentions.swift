import LodyCore
import Foundation

/// Official Cloud token broker + GitHub's bounded open issue/PR listing.
/// Neither the login credential nor the repository token leaves native memory.
@MainActor enum GitHubMentions {
  static func load(workspace: String, repo: String) async throws -> [String: Any] {
    guard GitHubCloud.validRepository(repo) else { throw GitHubCloud.failure() }
    guard let result = try await GitHubCloud.call(
      "action", path: "github:getAccessTokenByRepoNameForClient",
      args: ["workspaceId": workspace, "repoFullName": repo]
    ) as? [String: Any] else { throw GitHubCloud.failure() }
    if result["success"] as? Bool != true {
      if ["repo_not_linked", "installation_not_found", "repo_not_authorized"].contains(result["errorCode"] as? String ?? "") {
        return ["items": [], "truncated": false, "incomplete": false]
      }
      throw GitHubCloud.failure()
    }
    guard let repositoryToken = result["token"] as? String, !repositoryToken.isEmpty else { throw GitHubCloud.failure() }
    var items: [[String: Any]] = []
    var seen = Set<Int>()
    var count = 0
    for page in 1...2 {
      try Task.checkCancellation()
      guard let rows = try await GitHubCloud.request(
        "https://api.github.com/repos/\(repo)/issues?state=open&per_page=100&sort=updated&direction=desc&page=\(page)",
        token: repositoryToken
      ) as? [[String: Any]] else { throw GitHubCloud.failure() }
      count += rows.count
      for row in rows {
        guard row["state"] as? String == "open", let number = row["number"] as? Int, number > 0,
              let title = row["title"] as? String, !title.isEmpty, title.count <= 4096,
              seen.insert(number).inserted else { continue }
        let kind = row["pull_request"] == nil ? "issue" : "pr"
        items.append(["path": "\(kind):\(number)", "name": title, "kind": kind, "subtitle": "\(repo) #\(number)", "insertText": "#\(number)"])
      }
      if rows.count < 100 { break }
    }
    return ["items": items, "truncated": count >= 200, "incomplete": false]
  }
}

/// Official workspace repository discovery and token broker. Only projections
/// leave native code; the app credential and broker tokens stay in memory.
@MainActor enum GitHubCloud {
  static func validRepository(_ repo: String) -> Bool {
    repo.trimmingCharacters(in: .whitespacesAndNewlines) == repo &&
      repo.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$"#, options: .regularExpression) != nil &&
      ![".", ".."].contains(repo.components(separatedBy: "/").last ?? "")
  }

  static func branches(workspace: String, repo: String, page: Int) async throws -> CreateBranches {
    guard validRepository(repo), page > 0, page < Int.max else { throw failure() }
    let account = try AuthKeychain.read()
    guard let result = try await call(
      "action", path: "github:getAccessTokenByRepoNameForClient",
      args: ["workspaceId": workspace, "repoFullName": repo]
    ) as? [String: Any], result["success"] as? Bool == true,
      let token = result["token"] as? String, !token.isEmpty else { throw failure() }
    try Task.checkCancellation()
    let base = "https://api.github.com/repos/\(repo)"
    var defaultBranch: String?
    if page == 1 {
      guard let repository = try await request(base, token: token) as? [String: Any] else { throw failure() }
      guard let name = repository["default_branch"] as? String, !name.isEmpty, name.utf8.count <= 255 else { throw failure() }
      defaultBranch = name
    }
    guard let rows = try await request("\(base)/branches?per_page=100&page=\(page)", token: token) as? [[String: Any]],
      rows.count <= 100 else { throw failure() }
    var names = try rows.map { row -> String in
      guard let name = row["name"] as? String, !name.isEmpty, name.utf8.count <= 255 else { throw failure() }
      return name
    }
    // An empty repository has a configured default name but no branch to select.
    if !names.isEmpty, let name = defaultBranch, !name.isEmpty, name.utf8.count <= 255 {
      names.append(name)
    } else if names.isEmpty { defaultBranch = nil }
    try Task.checkCancellation()
    guard try AuthKeychain.read() == account else { throw failure() }
    return CreateBranches(names: Array(Set(names)), defaultBranch: defaultBranch, nextPage: rows.count == 100 ? page + 1 : nil)
  }

  static func repositories(workspace: String) async throws -> [String] {
    let value = try await call("query", path: "github:getWorkspaceRepositories", args: ["workspaceId": workspace])
    if value is NSNull { return [] }
    guard let rows = value as? [[String: Any]] else { throw failure() }
    var seen = Set<String>()
    return try rows.compactMap { row in
      guard let name = row["fullName"] as? String, validRepository(name) else { throw failure() }
      return seen.insert(name.lowercased()).inserted ? name : nil
    }
  }

  static func call(_ kind: String, path: String, args: [String: Any]) async throws -> Any {
    guard let credential = try AuthKeychain.read(), !credential.isEmpty else { throw failure() }
    for attempt in 0..<2 {
      let jwt = try await convexToken(credential)
      do {
        let response = try await request(
          "\(BackendEnvironment.convex)/api/\(kind)", token: jwt,
          body: ["path": path, "format": "convex_encoded_json", "args": [args]]
        ) as? [String: Any]
        guard try AuthKeychain.read() == credential,
              response?["status"] as? String == "success", let value = response?["value"] else { throw failure() }
        return value
      } catch where (error as NSError).code == 401 && attempt == 0 {
        // Convex rejected the reused token before running the function; mint one and retry once.
        if convexJWT?.token == jwt { convexJWT = nil }
      }
    }
    throw failure()
  }

  private static var convexJWT: (credential: String, token: String, until: Date)?
  private static var convexJWTPending: (credential: String, task: Task<String, Error>)?

  /// The Convex token for this credential, reused until a minute before it expires, so a
  /// Convex call is one round trip instead of a token exchange plus the call.
  static func convexToken(_ credential: String) async throws -> String {
    if let cached = convexJWT, cached.credential == credential, cached.until > Date() { return cached.token }
    if let pending = convexJWTPending, pending.credential == credential { return try await pending.task.value }
    let task = Task { () throws -> String in
      let auth = try await request("\(BackendEnvironment.site)/api/auth/convex/token", token: credential) as? [String: Any]
      guard let jwt = auth?["token"] as? String, !jwt.isEmpty else { throw failure() }
      return jwt
    }
    convexJWTPending = (credential, task)
    defer { if convexJWTPending?.task == task { convexJWTPending = nil } }
    let jwt = try await task.value
    if try AuthKeychain.read() == credential { convexJWT = (credential, jwt, expiry(jwt)) }
    return jwt
  }

  /// A JWT's `exp` less a minute; a token without one is reused for a minute.
  static func expiry(_ jwt: String, now: Date = Date()) -> Date {
    let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
    var payload = parts.count == 3 ? parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") : ""
    while payload.count % 4 != 0 { payload += "=" }
    guard let data = Data(base64Encoded: payload),
          let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let exp = (claims["exp"] as? NSNumber)?.doubleValue else { return now.addingTimeInterval(60) }
    return Date(timeIntervalSince1970: exp - 60)
  }

  static func failure() -> NSError {
    NSError(domain: "LodyKit.GitHubCloud", code: 1, userInfo: [NSLocalizedDescriptionKey: "github_unavailable"])
  }
  static func request(_ address: String, token: String? = nil, body: [String: Any]? = nil) async throws -> Any {
    var request = URLRequest(url: URL(string: address)!, timeoutInterval: 15)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let response = response as? HTTPURLResponse else { throw failure() }
    if response.statusCode == 401 { throw NSError(domain: "LodyKit.GitHubCloud", code: 401, userInfo: [NSLocalizedDescriptionKey: "github_unavailable"]) }
    guard response.statusCode == 200, data.count <= 8 * 1024 * 1024 else { throw failure() }
    return try JSONSerialization.jsonObject(with: data)
  }
}
