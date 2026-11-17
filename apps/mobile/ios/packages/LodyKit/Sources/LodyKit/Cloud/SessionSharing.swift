import Foundation
import Security

/// Authenticated sharing operations stay native. The WebView receives only
/// per-share capabilities, never the Better Auth credential or Convex JWT.
@MainActor enum SessionSharing {
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
  static func run(_ operation: String, args: [String: Any], workspace: String, userId: String, session: URLSession? = nil) async throws -> Any {
    let transport = session ?? Self.transport
    guard !workspace.isEmpty, !userId.isEmpty, let credential = try AuthKeychain.read(), !credential.isEmpty else { throw failure() }
    func check() throws {
      try Task.checkCancellation()
      guard try AuthKeychain.read() == credential else { throw failure() }
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
}
