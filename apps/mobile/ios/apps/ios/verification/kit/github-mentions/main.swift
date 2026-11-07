import Foundation
import os

enum AuthKeychain {
  static let token = OSAllocatedUnfairLock(initialState: "synthetic-app-token")
  static func read() throws -> String? { token.withLock { $0 } }
}

final class GitHubProtocol: URLProtocol {
  static let urls = OSAllocatedUnfairLock(initialState: [String]())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let address = request.url!.absoluteString
    Self.urls.withLock { $0.append(address) }
    var body: Any = [:]
    var status = 200
    if request.url?.host == "backend.lody.ai" {
      assert(request.url?.path == "/api/auth/convex/token")
      assert(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-app-token")
      body = ["token": "synthetic-convex-jwt"]
    } else if request.url?.host == "convex.lody.ai" {
      assert(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-convex-jwt")
      var data = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count <= 0 { break }
          data.append(contentsOf: buffer.prefix(count))
        }
      }
      let payload = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      let args = (payload["args"] as! [[String: Any]])[0]
      assert(args["cliToken"] == nil, "Login credentials are not CLI tokens")
      let workspace = args["workspaceId"] as! String
      if payload["path"] as? String == "github:getWorkspaceRepositories" {
        assert(request.url?.path == "/api/query")
        switch workspace {
        case "empty": body = ["status": "success", "value": []]
        case "unlinked": body = ["status": "success", "value": NSNull()]
        case "failure": body = ["status": "error", "errorMessage": "forbidden"]
        case "malformed": body = ["status": "success", "value": [["fullName": "owner/.."]]]
        default:
          body = ["status": "success", "value": [["fullName": "LodyAI/FreshProject", "private": true], ["fullName": "lodyai/freshproject"], ["fullName": "Other/Repo"]]]
        }
        if workspace == "account-switch" { AuthKeychain.token.withLock { $0 = "new-account" } }
      } else if workspace == "unlinked" {
        assert(payload["path"] as? String == "github:getAccessTokenByRepoNameForClient")
        assert(args["repoFullName"] as? String == "LodyAI/Lody")
        body = ["status": "success", "value": ["success": false, "errorCode": "repo_not_linked"]]
      } else {
        assert(request.url?.path == "/api/action")
        assert(payload["path"] as? String == "github:getAccessTokenByRepoNameForClient")
        assert(args["repoFullName"] as? String == "LodyAI/Lody")
        body = ["status": "success", "value": ["success": true, "token": "synthetic-repo-" + workspace]]
      }
    } else {
      assert(request.url?.host == "api.github.com")
      let branchRequest = request.url?.path == "/repos/LodyAI/Lody/branches"
      let repoRequest = request.url?.path == "/repos/LodyAI/Lody"
      assert(branchRequest || repoRequest || request.url?.path == "/repos/LodyAI/Lody/issues")
      let token = request.value(forHTTPHeaderField: "Authorization")!
      assert(token.hasPrefix("Bearer synthetic-repo-"), "App credentials must never go to GitHub")
      if token.hasSuffix("failure") { status = 503 }
      if repoRequest {
        body = ["default_branch": "trunk"]
      } else if branchRequest {
        let page = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "page" }!.value!
        if token.hasSuffix("empty") { body = [] as [[String: String]] }
        else if token.hasSuffix("malformed") { body = [["name": ""]] }
        else if page == "1" { body = (1...100).map { ["name": "feature/\($0)"] } }
        else { body = [["name": "feature/later"]] }
        if token.hasSuffix("account-switch") { AuthKeychain.token.withLock { $0 = "new-account" } }
      } else if token.hasSuffix("full") {
        let page = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "page" }!.value!
        let offset = (Int(page)! - 1) * 100
        body = (1...100).map { ["number": offset + $0, "title": "Issue \(offset + $0)", "state": "open"] as [String: Any] }
      } else {
        body = [
          ["number": 11, "title": "Issue", "state": "open"],
          ["number": 12, "title": "PR", "state": "open", "pull_request": [:]],
          ["number": 13, "title": "Closed", "state": "closed"],
          ["number": 11, "title": "Duplicate", "state": "open"],
        ] as [[String: Any]]
      }
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@main @MainActor struct Check {
  static func main() async throws {
    URLProtocol.registerClass(GitHubProtocol.self)
    let linked = try await GitHubMentions.load(workspace: "linked", repo: "LodyAI/Lody")
    let items = linked["items"] as! [[String: Any]]
    assert(items.count == 2 && items[0]["kind"] as? String == "issue" && items[1]["kind"] as? String == "pr")
    assert(items[0]["insertText"] as? String == "#11" && items[1]["insertText"] as? String == "#12")
    assert(!String(describing: linked).contains("synthetic"), "Projected catalogs must never expose credentials")
    let before = GitHubProtocol.urls.withLock { $0.count }
    let unlinked = try await GitHubMentions.load(workspace: "unlinked", repo: "LodyAI/Lody")
    assert((unlinked["items"] as! [Any]).isEmpty)
    assert(GitHubProtocol.urls.withLock { $0.count } == before + 2, "Unconnected projects must not fetch GitHub")
    let full = try await GitHubMentions.load(workspace: "full", repo: "LodyAI/Lody")
    assert((full["items"] as! [Any]).count == 200 && full["truncated"] as? Bool == true)
    do {
      _ = try await GitHubMentions.load(workspace: "failure", repo: "LodyAI/Lody")
      fatalError("Network failure must not masquerade as an empty connected catalog")
    } catch { assert(error.localizedDescription == "github_unavailable") }
    let after = GitHubProtocol.urls.withLock { $0.count }
    for repo in ["../repo", "LodyAI/..", "x/y?token=bad", "https://example.invalid", "LodyAI/Lody/extra", "LodyAI/Lody\n"] {
      do { _ = try await GitHubMentions.load(workspace: "linked", repo: repo); fatalError("Invalid repository accepted") } catch {}
    }
    assert(GitHubProtocol.urls.withLock { $0.count } == after)
    let repositories = try await GitHubCloud.repositories(workspace: "linked")
    assert(repositories == ["LodyAI/FreshProject", "Other/Repo"], "Discover repositories with no session history and deduplicate names")
    for workspace in ["empty", "unlinked"] {
      let empty = try await GitHubCloud.repositories(workspace: workspace)
      assert(empty.isEmpty)
    }
    for workspace in ["failure", "malformed", "account-switch"] {
      do { _ = try await GitHubCloud.repositories(workspace: workspace); fatalError("Invalid repository response accepted") }
      catch { assert(error.localizedDescription == "github_unavailable") }
    }
    AuthKeychain.token.withLock { $0 = "synthetic-app-token" }
    let first = try await GitHubCloud.branches(workspace: "linked", repo: "LodyAI/Lody", page: 1)
    assert(first.defaultBranch == "trunk" && first.names.contains("trunk") && first.nextPage == 2)
    let second = try await GitHubCloud.branches(workspace: "linked", repo: "LodyAI/Lody", page: 2)
    assert(second.names == ["feature/later"] && second.nextPage == nil)
    let emptyBranches = try await GitHubCloud.branches(workspace: "empty", repo: "LodyAI/Lody", page: 1)
    assert(emptyBranches.names.isEmpty && emptyBranches.defaultBranch == nil, "Empty repo must not offer a nonexistent configured default")
    for workspace in ["unlinked", "failure", "malformed", "account-switch"] {
      do { _ = try await GitHubCloud.branches(workspace: workspace, repo: "LodyAI/Lody", page: 1); fatalError("Invalid branch response accepted") }
      catch { assert(error.localizedDescription == "github_unavailable") }
    }
    AuthKeychain.token.withLock { $0 = "synthetic-app-token" }
    let beforeInvalid = GitHubProtocol.urls.withLock { $0.count }
    do { _ = try await GitHubCloud.branches(workspace: "linked", repo: "owner/..", page: 1); fatalError("Invalid branch repo accepted") } catch {}
    do { _ = try await GitHubCloud.branches(workspace: "linked", repo: "LodyAI/Lody", page: 0); fatalError("Invalid page accepted") } catch {}
    assert(GitHubProtocol.urls.withLock { $0.count } == beforeInvalid)
    print("GitHub mentions: Issue/PR references, unconnected project, bounded listing, credential isolation and failure behavior passed")
  }
}
