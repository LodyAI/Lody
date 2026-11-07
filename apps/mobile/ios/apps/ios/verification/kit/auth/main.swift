import Foundation

final class Fixture: @unchecked Sendable {
  var now = 0.0
  var waits: [Double] = []
  var requests: [URLRequest] = []
  var replies: [(Any, Int)] = []

  func api() -> AuthAPI {
    var api = AuthAPI()
    api.now = { self.now }
    api.sleep = { milliseconds in
      try Task.checkCancellation()
      self.waits.append(milliseconds)
      self.now += milliseconds
    }
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
    let code = DeviceCode(deviceCode: "synthetic", userCode: "CODE", verificationURL: "https://lody.ai/device", expiresIn: 30, interval: 1)
    var fixture = Fixture()
    fixture.replies = [(["error": "authorization_pending"], 400), (["error": "slow_down"], 400), (["access_token": "synthetic-token"], 200)]
    let token = try await fixture.api().pollToken(code)
    precondition(token == "synthetic-token" && fixture.waits == [1000, 1000, 6000])
    precondition(fixture.body(0)["grant_type"] as? String == "urn:ietf:params:oauth:grant-type:device_code")
    precondition(fixture.body(0)["client_id"] as? String == "lody-cli" && fixture.body(0)["device_code"] as? String == "synthetic")
    precondition(fixture.requests[0].url?.absoluteString == "https://backend.lody.ai/api/auth/device/token")
    fixture = Fixture()
    fixture.replies = [(["error": "access_denied"], 400)]
    let result1 = await failure { _ = try await fixture.api().pollToken(code) }
    precondition(result1?.message == "auth.error.accessDenied")
    fixture = Fixture()
    let short = DeviceCode(deviceCode: "synthetic", userCode: "CODE", verificationURL: "", expiresIn: 1, interval: 1)
    let result2 = await failure { _ = try await fixture.api().pollToken(short) }
    precondition(result2?.message == "auth.error.codeExpired")
    precondition(fixture.requests.isEmpty, "must not request after expiry")
    fixture = Fixture()
    var waiting = fixture.api()
    waiting.sleep = { _ in try await Task.sleep(nanoseconds: 60_000_000_000) }
    let cancelled = Task { [waiting] in try await waiting.pollToken(code) }
    cancelled.cancel()
    let cancelledToken = try? await cancelled.value
    precondition(cancelledToken == nil && fixture.requests.isEmpty, "must not request after cancellation")
    print("PASS: device authorization honors pending, slow down, expiry, denial and cancellation")

    fixture = Fixture()
    let device: [String: Any] = ["device_code": "synthetic-device", "user_code": "TESTCODE", "expires_in": 300, "interval": 5]
    fixture.replies = [
      (device.merging(["verification_uri_complete": "https://backend.lody.ai/device?user_code=TESTCODE"]) { $1 }, 200),
      (device.merging(["verification_uri_complete": "https://untrusted.invalid/device?user_code=TESTCODE"]) { $1 }, 200),
      (device.merging(["verification_uri_complete": "https://lody.ai/device", "interval": true]) { $1 }, 200),
    ]
    let issued = try await fixture.api().deviceCode()
    precondition(issued.verificationURL == "https://lody.ai/device?user_code=TESTCODE" && issued.userCode == "TESTCODE")
    precondition(fixture.body(0)["client_id"] as? String == "lody-cli" && fixture.requests[0].httpMethod == "POST")
    let result3 = await failure { _ = try await fixture.api().deviceCode() }
    precondition(result3?.message == "auth.error.invalidAuthorizeUrl")
    let result4 = await failure { _ = try await fixture.api().deviceCode() }
    precondition(result4?.message == "auth.error.invalidExpiry")
    print("PASS: official auth-site device URL opens the web approval page and rejects foreign origins")

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
