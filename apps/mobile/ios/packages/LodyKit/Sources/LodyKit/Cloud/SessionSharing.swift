import Foundation
import Security

/// Authenticated sharing operations stay native. The WebView receives only
/// per-share capabilities, never the Better Auth credential or Convex JWT.
@MainActor enum SessionSharing {
  struct ManagementFailure: Error { let code: String }
  typealias ManagementCall = @MainActor (String, [String: Any]) async throws -> Any
  typealias LinkAction = @MainActor (String, URL) async throws -> Void
  private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
      willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  }
  private static let transport = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
  private struct HTTPStatus: Error { let code: Int }
  private static func failure() -> NSError {
    NSError(domain: "LodyKit.SessionSharing", code: 1, userInfo: [NSLocalizedDescriptionKey: "share_unavailable"])
  }
  private static func identifier(_ value: Any?) throws -> String {
    guard let value = value as? String, value.range(of: #"^[a-zA-Z0-9_-]{1,128}$"#, options: .regularExpression) != nil else { throw failure() }
    return value
  }
  static func run(_ operation: String, args: [String: Any], workspace: String, userId: String, session: URLSession? = nil, useLink: LinkAction? = nil) async throws -> Any {
    let transport = session ?? Self.transport
    guard !workspace.isEmpty, !userId.isEmpty, let credential = try AuthKeychain.read(), !credential.isEmpty else { throw failure() }
    func check() throws {
      try Task.checkCancellation()
      guard try AuthKeychain.read() == credential else { throw failure() }
    }
    if operation == "management" {
      do {
        var jwt: String?
        return try await management(args, workspace: workspace, userId: userId, check: check, call: { method, fields in
          try check()
          if jwt == nil {
            let auth = try await request("\(BackendEnvironment.site)/api/auth/convex/token", credential: credential, transport: transport, timeout: 15)
            try check()
            guard let token = auth["token"] as? String, !token.isEmpty else { throw failure() }
            jwt = token
          }
          let kind = method == "revoke" ? "mutation" : "query"
          let response: [String: Any]
          do {
            response = try await request("\(BackendEnvironment.convex)/api/\(kind)", credential: jwt!, body: [
              "path": "sessionSharing:\(method)", "format": "convex_encoded_json", "args": [fields]
            ], transport: transport, timeout: 15)
          } catch let error as HTTPStatus where [401, 403].contains(error.code) {
            throw ManagementFailure(code: "shares_forbidden")
          }
          try check()
          guard response["status"] as? String == "success", let value = response["value"] else {
            var data = response["errorData"]
            if let text = data as? String, let bytes = text.data(using: .utf8) { data = try? JSONSerialization.jsonObject(with: bytes) }
            let code = (data as? [String: Any])?["code"] as? String
            let known = ["share_forbidden": "shares_forbidden", "unauthenticated": "shares_forbidden",
                         "share_conflict": "shares_conflict", "share_unavailable": "shares_unavailable"]
            if let code, let safe = known[code] { throw ManagementFailure(code: safe) }
            throw failure()
          }
          return value
        }, secret: { share, version in
          try check()
          return try await run("readSecret", args: ["shareId": share, "version": version], workspace: workspace, userId: userId, session: session) as? String
        }, useLink: useLink)
      } catch let error as ManagementFailure { return ["error": error.code] }
      catch let error as HTTPStatus where [401, 403].contains(error.code) { return ["error": "shares_forbidden"] }
      catch { return ["error": "shares_unavailable"] }
    }
    if operation == "readSecret" || operation == "saveSecret" {
      let share = try identifier(args["shareId"])
      guard let version = args["version"] as? Int, version > 0 else { throw failure() }
      let key = String(data: try JSONSerialization.data(withJSONObject: [userId, workspace, share, String(version)]), encoding: .utf8)!
      let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "ai.lody.mobile.session-shares", kSecAttrAccount as String: key]
      if operation == "saveSecret" {
        guard let secret = args["secret"] as? String,
          secret.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil else { throw failure() }
        let values = [kSecValueData as String: Data(secret.utf8)]
        var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
          var item = query.merging(values) { _, new in new }
          item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
          status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw failure() }
        return true
      }
      var request = query
      request[kSecReturnData as String] = true
      request[kSecMatchLimit as String] = kSecMatchLimitOne
      var value: CFTypeRef?
      let status = SecItemCopyMatching(request as CFDictionary, &value)
      if status == errSecItemNotFound { return NSNull() }
      guard status == errSecSuccess, let data = value as? Data, let secret = String(data: data, encoding: .utf8) else { throw failure() }
      return secret
    }
    if operation == "image" {
      let session = try identifier(args["sessionId"]), image = try identifier(args["imageId"])
      let url = SessionAttachments.imageDownloadURL(workspace: workspace, session: session, imageId: image)
      var request = URLRequest(url: url, timeoutInterval: 60)
      request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
      let (file, response) = try await transport.download(for: request)
      defer { try? FileManager.default.removeItem(at: file) }
      try check()
      guard let response = response as? HTTPURLResponse, response.statusCode == 200,
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 100 * 1024 * 1024 else { throw failure() }
      let bytes = try Data(contentsOf: file)
      return ["base64": bytes.base64EncodedString(), "mediaType": response.mimeType ?? "application/octet-stream"]
    }
    if operation == "previewToken" {
      guard let intent = args["intent"] as? [String: Any], intent["workspaceId"] as? String == workspace else { throw failure() }
      let response: [String: Any]
      do {
        response = try await request("\(BackendEnvironment.site)/api/session-preview/request-token", credential: credential, body: intent, transport: transport)
      } catch let error as HTTPStatus {
        return ["status": error.code]
      }
      try check()
      guard response["requesterUserId"] as? String == userId, let token = response["requestToken"] as? String, !token.isEmpty else { throw failure() }
      return token
    }
    guard operation == "api", let method = args["method"] as? String,
      ["getManagement", "beginDeployment", "publishDeployment", "resetCredential", "revoke"].contains(method),
      let values = args["args"] as? [String: Any] else { throw failure() }
    if method == "getManagement" || method == "beginDeployment" {
      guard values["workspaceId"] as? String == workspace else { throw failure() }
    }
    let auth = try await request("\(BackendEnvironment.site)/api/auth/convex/token", credential: credential, transport: transport)
    try check()
    guard let jwt = auth["token"] as? String, !jwt.isEmpty else { throw failure() }
    let kind = method == "getManagement" ? "query" : "mutation"
    let response = try await request("\(BackendEnvironment.convex)/api/\(kind)", credential: jwt, body: [
      "path": "sessionSharing:\(method)", "format": "convex_encoded_json", "args": [values]
    ], transport: transport)
    try check()
    guard response["status"] as? String == "success", let result = response["value"] else { throw failure() }
    return result
  }
  private static func request(_ address: String, credential: String, body: [String: Any]? = nil, transport: URLSession, timeout: TimeInterval = 30) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: address)!, timeoutInterval: timeout)
    request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (file, response) = try await transport.download(for: request)
    defer { try? FileManager.default.removeItem(at: file) }
    try Task.checkCancellation()
    guard let response = response as? HTTPURLResponse else { throw failure() }
    guard (200..<300).contains(response.statusCode) else { throw HTTPStatus(code: response.statusCode) }
    guard let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 2 * 1024 * 1024,
      let value = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] else { throw failure() }
    return value
  }

  /// Official list/getManagement/revoke contract. Only summary fields leave native code.
  static func management(_ args: [String: Any], workspace: String, userId: String,
    check: @MainActor () throws -> Void, call: ManagementCall,
    secret: @MainActor (String, Int) async throws -> String?, useLink: LinkAction? = nil
  ) async throws -> [String: Any] {
    try check()
    guard args["workspaceId"] as? String == workspace,
      let action = args["action"] as? String, ["list", "detail", "open", "copy", "revoke"].contains(action)
    else { throw ManagementFailure(code: "shares_unavailable") }
    func integer(_ value: Any?, minimum: Int = 0) throws -> Int {
      guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
        n.doubleValue.isFinite, n.doubleValue >= Double(minimum), n.doubleValue <= 9_007_199_254_740_991,
        n.doubleValue.rounded() == n.doubleValue else { throw failure() }
      return n.intValue
    }
    func text(_ value: Any?, limit: Int = 200) throws -> String {
      guard let text = value as? String, !text.isEmpty, text.utf8.count <= limit else { throw failure() }
      return text
    }
    func boolean(_ value: Any?) throws -> Bool {
      guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw failure() }
      return value.boolValue
    }
    @MainActor func project(_ value: Any, inventory: Bool = false) async throws -> [String: Any] {
      guard let row = value as? [String: Any], let status = row["status"] as? String,
        ["active", "revoked"].contains(status), let title = row["title"] as? String, title.utf8.count <= 4096 else { throw failure() }
      let manage = try boolean(row["canManage"]), revoke = try boolean(row["canRevoke"])
      let share = try identifier(row["shareId"]), version = try integer(row["credentialVersion"], minimum: 1)
      let publisher = try text(row["publisherUserId"])
      var result: [String: Any] = [
        "shareId": share, "rootSessionId": try text(row["rootSessionId"]), "publisherUserId": publisher,
        "status": status, "title": title, "revision": try integer(row["revision"]),
        "credentialVersion": version, "createdAt": try integer(row["createdAt"]), "updatedAt": try integer(row["updatedAt"]),
        "canManage": manage, "canRevoke": revoke, "hasLocalLink": false
      ]
      if inventory {
        result["totalBytes"] = try integer(row["totalBytes"])
        result["conversationCount"] = try integer(row["conversationCount"])
      }
      // Administration grants inventory/revocation, never another publisher's bearer.
      if publisher == userId && status == "active", let key = try await secret(share, version),
        key.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil { result["hasLocalLink"] = true }
      try check()
      return result
    }
    func response(_ rows: [[String: Any]], done: Bool = true, cursor: String = "") -> [String: Any] {
      ["workspaceId": workspace, "userId": userId, "page": rows, "isDone": done, "continueCursor": cursor]
    }
    if action == "list" {
      let cursor = args["cursor"] as? String
      guard args["cursor"] == nil || args["cursor"] is NSNull || cursor != nil,
        (cursor?.utf8.count ?? 0) <= 4096 else { throw failure() }
      guard let page = try await call("list", ["workspaceId": workspace,
        "paginationOpts": ["numItems": 20, "cursor": cursor as Any? ?? NSNull()]]) as? [String: Any],
        let rows = page["page"] as? [Any], rows.count <= 20,
        let next = page["continueCursor"] as? String, next.utf8.count <= 4096 else { throw failure() }
      let done = try boolean(page["isDone"])
      guard done || (!next.isEmpty && next != cursor) else { throw failure() }
      try check()
      var projected: [[String: Any]] = [], ids = Set<String>()
      for row in rows {
        let entry = try await project(row, inventory: true)
        guard ids.insert(entry["shareId"] as! String).inserted else { throw failure() }
        projected.append(entry)
      }
      return response(projected, done: done, cursor: next)
    }
    let share = try identifier(args["shareId"]), root = try text(args["rootSessionId"])
    let scope: [String: Any] = ["workspaceId": workspace, "rootSessionId": root, "shareId": share]
    @MainActor func current() async throws -> [String: Any] {
      let entry = try await project(await call("getManagement", scope))
      guard entry["shareId"] as? String == share, entry["rootSessionId"] as? String == root else { throw failure() }
      return entry
    }
    var entry = try await current()
    if action == "detail" { return response([entry]) }
    let revision = try integer(args["expectedRevision"])
    guard entry["revision"] as? Int == revision else { throw ManagementFailure(code: "shares_conflict") }
    if action == "revoke" {
      guard entry["canRevoke"] as? Bool == true else { throw ManagementFailure(code: "shares_forbidden") }
      if entry["status"] as? String == "revoked" { return response([entry]) }
      try check()
      do {
        _ = try await call("revoke", ["shareId": share, "expectedRevision": revision])
      } catch let error as ManagementFailure where ["shares_forbidden", "shares_conflict"].contains(error.code) {
        throw error
      } catch { throw ManagementFailure(code: "shares_write_unknown") }
      do {
        try check()
        entry = try await current()
        guard entry["status"] as? String == "revoked", (entry["revision"] as? Int ?? -1) > revision else { throw failure() }
      } catch { throw ManagementFailure(code: "shares_write_unknown") }
      return response([entry])
    }
    guard entry["publisherUserId"] as? String == userId, entry["status"] as? String == "active",
      let key = try await secret(share, try integer(entry["credentialVersion"], minimum: 1)),
      key.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
      let url = URL(string: "https://share.lody.ai/s/\(share)#access=v1.\(key)"), let useLink
    else { throw ManagementFailure(code: "shares_link_unavailable") }
    try check()
    do { try await useLink(action, url) } catch { throw ManagementFailure(code: "shares_link_failed") }
    try check()
    return response([entry])
  }
}
