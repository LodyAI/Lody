import Foundation
import os

enum AuthKeychain { static func read() throws -> String? { "synthetic-app-credential" } }
enum SessionAttachments {
  static func imageDownloadURL(workspace: String, session: String, imageId: String) -> URL {
    URL(string: "https://api.lody.ai/api/workspaces/\(workspace)/session-images/\(session)/\(imageId)")!
  }
}
final class ShareProtocol: URLProtocol {
  static let calls = OSAllocatedUnfairLock(initialState: [String]())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let host = request.url!.host!
    Self.calls.withLock { $0.append(host) }
    var body: [String: Any]
    let token = request.value(forHTTPHeaderField: "Authorization")
    if host == "backend.lody.ai" {
      precondition(token == "Bearer synthetic-app-credential")
      body = ["token": "synthetic-jwt"]
    } else {
      precondition(host == "convex.lody.ai" && token == "Bearer synthetic-jwt")
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
      let path = payload["path"] as! String
      precondition(["sessionSharing:getManagement", "sessionSharing:revoke"].contains(path))
      precondition(request.url!.path == (path.hasSuffix("revoke") ? "/api/mutation" : "/api/query"))
      body = ["status": "success", "value": NSNull()]
      if path.hasSuffix("revoke") { body = ["status": "error", "errorMessage": "forbidden"] }
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
@main @MainActor struct Check {
  static func main() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ShareProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let result = try await SessionSharing.run("api", args: ["method": "getManagement", "args": ["workspaceId": "workspace", "rootSessionId": "root"]], workspace: "workspace", userId: "user", session: session)
    precondition(result is NSNull, "A missing share is not an active link")
    let before = ShareProtocol.calls.withLock { $0.count }
    do {
      _ = try await SessionSharing.run("api", args: ["method": "getManagement", "args": ["workspaceId": "other", "rootSessionId": "root"]], workspace: "workspace", userId: "user", session: session)
      fatalError("Cross-workspace request accepted")
    } catch {}
    do {
      _ = try await SessionSharing.run("api", args: ["method": "anything", "args": [:]], workspace: "workspace", userId: "user", session: session)
      fatalError("Arbitrary backend mutation accepted")
    } catch {}
    // The published-share inventory was removed from mobile; its broker operation no longer exists.
    do {
      _ = try await SessionSharing.run("management", args: ["workspaceId": "workspace", "action": "list"], workspace: "workspace", userId: "user", session: session)
      fatalError("Removed share inventory operation accepted")
    } catch {}
    precondition(ShareProtocol.calls.withLock { $0.count } == before)
    do {
      _ = try await SessionSharing.run("api", args: ["method": "revoke", "args": ["shareId": "share", "expectedRevision": 1]], workspace: "workspace", userId: "user", session: session)
      fatalError("Rejected mutation reported success")
    } catch { precondition(error.localizedDescription == "share_unavailable") }
    precondition(ShareProtocol.calls.withLock { $0.count } == before + 2, "Never replay a mutation")
    print("Sharing native boundary passed: scoped operations, native-only credentials, null state, rejected mutation and no replay")
  }
}
