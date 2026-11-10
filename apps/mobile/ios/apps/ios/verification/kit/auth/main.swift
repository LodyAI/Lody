import Foundation

final class Fixture: @unchecked Sendable {
  var requests: [URLRequest] = []
  var replies: [(Any, Int)] = []

  func api() -> AuthAPI {
    var api = AuthAPI()
    api.transport = { request in
      self.requests.append(request)
      precondition(!self.replies.isEmpty, "Unexpected request \(request.url!)")
      let (body, status) = self.replies.removeFirst()
      return (try JSONSerialization.data(withJSONObject: body, options: .fragmentsAllowed), status)
    }
    return api
  }

  func body(_ index: Int) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: requests[index].httpBody ?? Data())) as? [String: Any] ?? [:]
  }
}

@MainActor func failure(_ work: () async throws -> Void) async -> AuthFailure? {
  do { try await work(); return nil } catch { return error as? AuthFailure }
}

@main struct AuthCheck {
  static func main() async throws {
    if AuthAPI.authOrigin != "https://backend.lody.ai" {
      var api = AuthAPI()
      api.loginTransport = { _ in preconditionFailure("Nonproduction reset must never send a request") }
      let rejected = await failure { try await api.requestPasswordReset(email: "person@example.test") }
      precondition(rejected?.message == "auth.reset.unsupportedLocal")
      print("PASS: nonproduction password reset is rejected before any network request")
      return
    }
    var fixture = Fixture()
    var native = AuthAPI()
    native.loginTransport = { request in
      precondition(request.url?.absoluteString == "https://backend.lody.ai/api/auth/sign-in/email")
      precondition(request.httpMethod == "POST" && request.value(forHTTPHeaderField: "Authorization") == nil)
      let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
      precondition(body == ["email": "person@example.test", "password": "synthetic-password", "callbackURL": "https://backend.lody.ai/api/auth/mobile/email-verified"])
      return AuthAPI.Reply(data: Data("{\"token\":\"body-token\"}".utf8), status: 200, token: "body-token.synthetic-signature")
    }
    let emailToken = try await native.email(email: "person@example.test", password: "synthetic-password")
    precondition(emailToken == "body-token", "Streams authorization requires the raw JSON session token, not the signed cookie header")
    native.loginTransport = { request in
      let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
      precondition(request.url?.path == "/api/auth/sign-in/social" && body["provider"] as? String == "apple")
      let identity = body["idToken"] as! [String: String]
      precondition(identity == ["token": "synthetic-identity", "nonce": "synthetic-nonce"])
      return AuthAPI.Reply(data: Data("{\"token\":\"session-token\"}".utf8), status: 200)
    }
    let appleToken = try await native.idToken(provider: "apple", token: "synthetic-identity", nonce: "synthetic-nonce")
    precondition(appleToken == "session-token", "ID token exchange returns a session, never the provider token")
    for status in [302, 401, 500] {
      native.loginTransport = { _ in AuthAPI.Reply(data: Data("{\"token\":\"untrusted\"}".utf8), status: status, token: "untrusted") }
      let rejected = await failure { _ = try await native.email(email: "e", password: "p") }
      precondition(rejected != nil, "Redirect and error responses cannot install credentials")
    }
    // A signed cookie alone cannot authorize Lody's raw-token Streams endpoint.
    for body in ["{}", "{\"token\":null}", "{\"token\":\"\"}", "{\"token\":42}"] {
      native.loginTransport = { _ in AuthAPI.Reply(data: Data(body.utf8), status: 200, token: "body-token.synthetic-signature") }
      let missing = await failure { _ = try await native.email(email: "e", password: "p") }
      precondition(missing != nil, "Missing or invalid raw session tokens must be rejected even when a signed cookie header exists")
    }
    print("PASS: native login selects raw session credentials for Streams and rejects header-only or unsuccessful responses")

    let handoff = NativeAuthHandoff(state: "native-state", verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    precondition(handoff.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "Native OAuth uses RFC 7636 S256")
    let start = try handoff.startURL(provider: "github")
    let query = URLComponents(url: start, resolvingAgainstBaseURL: false)!.queryItems!
    precondition(start.host == "backend.lody.ai" && start.path == "/api/auth/mobile/start")
    precondition(query.first { $0.name == "redirect_uri" }?.value == "lody://auth/mobile-callback")
    precondition(!start.absoluteString.contains(handoff.verifier), "The browser never receives the PKCE verifier")
    let code = try handoff.code(from: URL(string: "lody://auth/mobile-callback?state=native-state&code=one-time-code")!)
    precondition(code == "one-time-code")
    for address in [
      "lody://auth/mobile-callback?state=wrong&code=c",
      "lody://auth/mobile-callback?state=native-state&state=native-state&code=c",
      "lody://auth/mobile-callback?state=native-state&code=c&token=leaked",
      "lody://auth/mobile-callback?state=native-state&error=oauth_failed",
      "lody://other/mobile-callback?state=native-state&code=c",
      "lody://auth/mobile-callback?state=native-state&code=c#fragment",
      "https://auth/mobile-callback?state=native-state&code=c",
    ] {
      let rejected = await failure { _ = try handoff.code(from: URL(string: address)!) }
      precondition(rejected != nil, "Foreign, duplicate, failed and mismatched callbacks cannot exchange credentials")
    }
    native.loginTransport = { request in
      precondition(request.url?.path == "/api/auth/mobile/exchange")
      let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
      precondition(body == ["code": "one-time-code", "code_verifier": handoff.verifier, "redirect_uri": NativeAuthHandoff.redirectURI])
      return AuthAPI.Reply(data: Data("{\"token\":\"native-session\"}".utf8), status: 200)
    }
    let exchanged = try await native.exchangeHandoff(code: code, handoff: handoff)
    precondition(exchanged == "native-session")
    print("PASS: provider callbacks are attempt-bound and exchange only with the local S256 verifier")

    native.loginTransport = { request in
      let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
      precondition(request.url?.path == "/api/auth/request-password-reset")
      precondition(body == ["email": "person@example.test", "redirectTo": "https://lody.ai/reset-password"])
      return AuthAPI.Reply(data: Data("{\"status\":true}".utf8), status: 200)
    }
    try await native.requestPasswordReset(email: "person@example.test")
    print("PASS: password reset requests keep completion on HTTPS, not a custom scheme")

    let registrationRequests = Fixture()
    native.loginTransport = { request in
      registrationRequests.requests.append(request)
      let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
      precondition(body["callbackURL"] == "https://backend.lody.ai/api/auth/mobile/email-verified")
      if request.url?.path == "/api/auth/sign-up/email" {
        precondition(body["name"] == "New User" && body["password"] == "synthetic-password")
        return AuthAPI.Reply(data: Data("{\"token\":null,\"user\":{\"id\":\"new-user\"}}".utf8), status: 200)
      }
      precondition(request.url?.path == "/api/auth/send-verification-email" && body["email"] == "new@example.test")
      return AuthAPI.Reply(data: Data("{\"status\":true}".utf8), status: 200)
    }
    let registration = try await native.register(name: "New User", email: "new@example.test", password: "synthetic-password")
    precondition(registration == nil && registrationRequests.requests.count == 2,
                 "Registration without a session explicitly sends verification because sendOnSignUp is disabled")
    try await native.resendVerification(email: "new@example.test")
    precondition(registrationRequests.requests.count == 3)
    native.loginTransport = { request in
      let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
      let identity = body["idToken"] as! [String: Any]
      let user = identity["user"] as! [String: Any]
      precondition(user["name"] as? [String: String] == ["firstName": "First", "lastName": "Last"],
                   "Apple first-consent name must survive the native ID-token exchange")
      return AuthAPI.Reply(data: Data("{\"token\":\"synthetic-session\"}".utf8), status: 200)
    }
    _ = try await native.idToken(provider: "apple", token: "synthetic-id-token", nonce: "nonce", name: ["firstName": "First", "lastName": "Last"])
    print("PASS: native registration explicitly sends verification and Apple first-consent names reach Better Auth")

    for (image, expected) in [("https://avatars.githubusercontent.com/u/1", "https://avatars.githubusercontent.com/u/1"),
                              ("http://avatars.githubusercontent.com/u/1", nil), ("javascript:alert(1)", nil), ("", nil)] as [(String, String?)] {
      fixture = Fixture()
      fixture.replies = [
        (["user": ["id": "u1", "email": "i@example.test", "name": "Innei", "image": image]], 200),
        ([["id": "w1", "name": "Innei", "slug": "innei", "logo": image]], 200),
      ]
      let account = try await fixture.api().account(token: "token")
      precondition(account.user.image == expected && account.workspaces[0].image == expected)
      precondition(fixture.requests.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer token", "Bearer token"])
      precondition(fixture.requests.map { $0.httpMethod } == ["GET", "GET"])
    }
    fixture = Fixture()
    fixture.replies = [(NSNull(), 200)]
    let result5 = await failure { _ = try await fixture.api().account(token: "token") }
    precondition(result5?.expired == true)
    fixture = Fixture()
    fixture.replies = [(["code": "UNAUTHORIZED"], 401)]
    let result6 = await failure { _ = try await fixture.api().account(token: "token") }
    precondition(result6?.expired == true)
    fixture = Fixture()
    fixture.replies = [(["user": ["id": "u1", "email": "i@example.test"]], 200), (["not": "a list"], 200)]
    let invalid = await failure { _ = try await fixture.api().account(token: "token") }
    precondition(invalid?.message == "auth.error.invalidWorkspaceList" && invalid?.expired == false)
    let encoded = AuthAccount(user: AuthUser(id: "u", name: "n", email: "e", image: nil),
                              workspaces: [AuthWorkspace(id: "w", name: "W", slug: nil, image: nil)]).json
    let expected: [String: Any] = ["user": ["id": "u", "name": "n", "email": "e"], "workspaces": [["id": "w", "name": "W", "slug": NSNull()]]]
    let decoded = try JSONSerialization.jsonObject(with: Data(encoded.utf8)) as! [String: Any]
    precondition(NSDictionary(dictionary: decoded).isEqual(to: expected))
    precondition(AuthAccount.decode(encoded)?.workspaces.first?.slug == nil && AuthAccount.userID(encoded) == "u")
    print("PASS: account and workspace photos keep https values; expired sessions are classified")

    fixture = Fixture()
    fixture.replies = [(["id": "w1", "name": "Renamed", "slug": "innei", "logo": "https://cdn.lody.ai/org.png"], 200)]
    let renamed = try await fixture.api().updateWorkspace(token: "token", id: "w1", name: "Renamed")
    precondition(renamed == AuthWorkspace(id: "w1", name: "Renamed", slug: "innei", image: "https://cdn.lody.ai/org.png"))
    precondition(fixture.requests[0].url?.path == "/api/auth/organization/update")
    precondition(NSDictionary(dictionary: fixture.body(0)).isEqual(to: ["organizationId": "w1", "data": ["name": "Renamed"]]))

    let file = FileManager.default.temporaryDirectory.appendingPathComponent("workspace-icon-\(UUID().uuidString).jpg")
    try Data("jpeg".utf8).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    fixture = Fixture()
    fixture.replies = [
      (["avatar": ["avatarId": "avatar/1"]], 200),
      (["id": "w one", "name": "Workspace", "logo": "https://api.lody.ai/api/avatars/avatar%2F1"], 200),
    ]
    let icon = WorkspaceIconFile(url: file, name: "workspace-icon.jpg", type: "image/jpeg", size: 4)
    let image = try await fixture.api().uploadWorkspaceIcon(token: "token", id: "w one", file: icon)
    precondition(image == "https://api.lody.ai/api/avatars/avatar%2F1")
    let upload = fixture.requests[0]
    precondition(upload.url?.absoluteString == "https://api.lody.ai/api/workspaces/w%20one/avatars/upload")
    precondition(upload.value(forHTTPHeaderField: "Authorization") == "Bearer token")
    precondition(upload.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
    let form = String(decoding: upload.httpBody ?? Data(), as: UTF8.self)
    precondition(form.contains("name=\"kind\"\r\n\r\nworkspace\r\n") && form.contains("filename=\"workspace-icon.jpg\"\r\nContent-Type: image/jpeg\r\n\r\njpeg\r\n"))
    let updatedIcon = try await fixture.api().updateWorkspaceIcon(token: "token", id: "w one", image: image)
    precondition(updatedIcon.image == image)
    precondition(NSDictionary(dictionary: fixture.body(1)).isEqual(to: ["organizationId": "w one", "data": ["logo": image]]))
    let oversized = WorkspaceIconFile(url: file, name: "big.jpg", type: "image/jpeg", size: 1024 * 1024 + 1)
    let result7 = await failure { _ = try await fixture.api().uploadWorkspaceIcon(token: "token", id: "w", file: oversized) }
    precondition(result7?.message == "workspace.edit.invalidIcon")

    fixture = Fixture()
    fixture.replies = [(["code": "FORBIDDEN"], 403), (["code": "FORBIDDEN"], 403)]
    let rename = await failure { _ = try await fixture.api().updateWorkspace(token: "token", id: "original", name: "Draft name") }
    let logo = await failure { _ = try await fixture.api().updateWorkspaceIcon(token: "token", id: "original", image: "https://cdn.lody.ai/icon.png") }
    precondition(rename?.message == "auth.error.requestFailed" && rename?.expired == false && logo?.expired == false)
    precondition(fixture.body(0)["organizationId"] as? String == "original" && fixture.body(1)["organizationId"] as? String == "original")
    fixture = Fixture()
    fixture.replies = [([String: Any](), 200)]
    try await fixture.api().signOut(token: "token")
    precondition(fixture.requests[0].url?.path == "/api/auth/sign-out" && fixture.requests[0].httpMethod == "POST")
    precondition(fixture.requests[0].httpBody == Data("{}".utf8))
    fixture = Fixture()
    fixture.replies = [
      (["total": 2, "members": [["id": "membership-1", "userId": "u1", "user": ["id": "u1", "name": "Alice", "image": "https://example.com/a.png"]]]], 200),
      (["total": 2, "members": [["id": "membership-2", "userId": "u2", "user": ["id": "u2", "name": "Bob", "image": "http://unsafe/b.png"]]]], 200),
    ]
    let members = try await fixture.api().members(token: "token", workspaceId: "w")
    precondition(members.map(\.id) == ["u1", "u2"] && members[1].image == nil)
    precondition(fixture.requests[1].url!.query!.contains("offset=1"))
    print("PASS: workspace members use user IDs, paginate and filter unsafe avatars")
    print("PASS: workspace rename, icon upload and sign-out keep the official contracts and reject permission errors")
  }
}
