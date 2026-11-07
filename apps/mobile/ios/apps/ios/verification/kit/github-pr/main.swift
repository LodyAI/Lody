import Foundation
import os

enum AuthKeychain { static func read() throws -> String? { "synthetic-app-token" } }
final class PRProtocol: URLProtocol {
  static let calls = OSAllocatedUnfairLock(initialState: [(String, String)]())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url!.path
    let method = request.httpMethod ?? "GET"
    Self.calls.withLock { $0.append((path, method)) }
    var body: Any = [:]
    var status = 200
    var headers: [String: String] = [:]
    let token = request.value(forHTTPHeaderField: "Authorization") ?? ""
    if request.url?.host == "backend.lody.ai" {
      precondition(token == "Bearer synthetic-app-token")
      body = ["token": "synthetic-jwt"]
    } else if request.url?.host == "convex.lody.ai" {
      precondition(token == "Bearer synthetic-jwt")
      var data = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count)) }
      }
      let payload = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      precondition(payload["path"] as? String == "github:getOperationAccessTokenByRepoNameForClient")
      let args = (payload["args"] as! [[String: Any]])[0]
      precondition(["read", "write"].contains(args["operation"] as! String))
      body = ["status": "success", "value": ["success": true, "token": "synthetic-repo-\(args["workspaceId"]!)"]]
    } else {
      precondition(request.url?.host == "api.github.com" && token.hasPrefix("Bearer synthetic-repo-"))
      if path.hasSuffix("/pulls/31") {
        body = ["title": "A PR", "state": "open", "draft": false, "merged": false, "head": ["sha": "abcdef012345", "ref": "feature"], "base": ["ref": "main"], "user": ["login": "Author"]]
      } else if path.contains("/check-runs") {
        precondition(path.contains("abcdef012345"), "Checks must belong to the fetched head")
        body = ["total_count": 2, "check_runs": [["id": 9, "name": "Test", "status": "completed", "conclusion": "success", "html_url": "https://github.com/a/b/runs/9"]]]
        if token.hasSuffix("denied") { status = 403 }
      } else if request.httpMethod == "POST" {
        precondition(path.hasSuffix("/issues/31/comments"))
        status = token.hasSuffix("unknown") ? 503 : 201
      } else {
        precondition(path.hasSuffix("/issues/31/comments"))
        body = [["id": 1, "body": "Comment", "user": ["login": "Commenter"]]]
        headers["Link"] = "<https://api.github.com/next>; rel=\"next\""
      }
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
@main @MainActor struct Check {
  static func main() async throws {
    URLProtocol.registerClass(PRProtocol.self)
    func run(_ workspace: String, operation: String = "read", repository: String = "LodyAI/Lody") async throws -> String {
      let args: [String: Any] = ["workspaceId": workspace, "repository": repository, "number": 31, "operation": operation, "body": "A comment"]
      return try await GitHubPullRequests.run(String(decoding: JSONSerialization.data(withJSONObject: args), as: UTF8.self))
    }
    let raw = try await run("linked")
    precondition(!raw.contains("synthetic"), "Credentials must not leave native code")
    let pr = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]
    precondition(pr["headSha"] as? String == "abcdef012345" && pr["checksTruncated"] as? Bool == true)
    precondition(pr["commentsTruncated"] as? Bool == true && pr["author"] as? String == "Author")
    let denied = try await run("denied")
    precondition(denied.contains("checksError") && denied.contains("forbidden"), "Missing permission is not a passing CI")
    _ = try await run("linked", operation: "comment")
    let before = PRProtocol.calls.withLock { $0.filter { $0.1 == "POST" && $0.0.hasSuffix("/comments") }.count }
    do { _ = try await run("unknown", operation: "comment"); fatalError("Uncertain write reported success") }
    catch { precondition(error.localizedDescription == "comment_unknown") }
    precondition(PRProtocol.calls.withLock { $0.filter { $0.1 == "POST" && $0.0.hasSuffix("/comments") }.count } == before + 1, "Never replay a write")
    let count = PRProtocol.calls.withLock { $0.count }
    do { _ = try await run("linked", repository: "x/.."); fatalError("Invalid repo accepted") } catch {}
    precondition(PRProtocol.calls.withLock { $0.count } == count)
    print("PR read/write boundary: head-scoped checks, partial state, permission failure, comments, credential isolation and no write replay passed")
  }
}
