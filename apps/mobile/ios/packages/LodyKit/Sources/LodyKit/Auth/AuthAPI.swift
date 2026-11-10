import Foundation

struct WorkspaceMember: Codable, Equatable, Sendable {
  let id: String
  let name: String
  let image: String?
}

struct AuthUser: Codable, Equatable, Sendable {
  let id: String
  let name: String
  let email: String
  let image: String?
}

struct AuthWorkspace: Codable, Equatable, Sendable {
  let id: String
  let name: String
  let slug: String?
  let image: String?

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(name, forKey: .name)
    try container.encode(slug, forKey: .slug)
    try container.encodeIfPresent(image, forKey: .image)
  }
}

struct AuthAccount: Codable, Equatable, Sendable {
  let user: AuthUser
  var workspaces: [AuthWorkspace]

  static func decode(_ json: String?) -> AuthAccount? {
    guard let json, let account = try? JSONDecoder().decode(AuthAccount.self, from: Data(json.utf8)),
          !account.user.id.isEmpty else { return nil }
    return account
  }

  static func userID(_ json: String?) -> String? {
    guard let json, let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
          let user = object["user"] as? [String: Any] else { return nil }
    return user["id"] as? String
  }

  var json: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "null"
  }
}

struct WorkspaceIconFile: Sendable {
  let url: URL
  let name: String
  let type: String
  let size: Int
}

struct AuthFailure: LocalizedError {
  let message: String
  var expired = false

  var errorDescription: String? { message }
}

struct AuthAPI: Sendable {
  typealias Transport = @Sendable (URLRequest) async throws -> (Data, Int)

  static let authOrigin = BackendEnvironment.site
  static let cloudOrigin = BackendEnvironment.worker
  private static let iconTypes: Set<String> = ["image/png", "image/jpeg", "image/webp", "image/gif"]
  private static let iconMaxBytes = 1024 * 1024
  private static let componentCharacters = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
  )
  // Never follow redirects carrying credentials or replay a password POST elsewhere.
  private final class RedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
      completionHandler(nil)
    }
  }
  private static let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 30
    return URLSession(configuration: configuration, delegate: RedirectPolicy(), delegateQueue: nil)
  }()

  var transport: Transport = { request in
    let reply = try await nativeTransport(request)
    return (reply.data, reply.status)
  }
  struct Reply: Sendable {
    let data: Data
    let status: Int
    var token: String? = nil
  }
  var loginTransport: @Sendable (URLRequest) async throws -> Reply = Self.nativeTransport

  private static func nativeTransport(_ request: URLRequest) async throws -> Reply {
    do {
      let (data, response) = try await session.data(for: request)
      guard let response = response as? HTTPURLResponse else { throw AuthFailure(message: String(localized: "auth.error.invalidResponse", bundle: .lody)) }
      return Reply(data: data, status: response.statusCode, token: response.value(forHTTPHeaderField: "set-auth-token"))
    } catch let error as URLError where error.code != .cancelled {
      throw AuthFailure(message: String(localized: "auth.native.network", bundle: .lody))
    }
  }

  func email(email: String, password: String) async throws -> String {
    try await authenticate("/sign-in/email", body: ["email": email, "password": password, "callbackURL": Self.authOrigin + "/api/auth/mobile/email-verified"])
  }

  func idToken(provider: String, token: String, nonce: String? = nil, name: [String: String]? = nil) async throws -> String {
    guard ["apple", "google"].contains(provider) else { throw AuthFailure(message: String(localized: "auth.error.invalidResponse", bundle: .lody)) }
    var identity: [String: Any] = ["token": token]
    if let nonce { identity["nonce"] = nonce }
    if provider == "apple", let name, !name.isEmpty { identity["user"] = ["name": name] }
    return try await authenticate("/sign-in/social", body: ["provider": provider, "idToken": identity])
  }

  func authenticate(_ path: String, body: [String: Any], native: Bool = false) async throws -> String {
    let reply = try await credentialReply(path, body: body, native: native)
    return try Self.sessionToken(reply)
  }

  func register(name: String, email: String, password: String) async throws -> String? {
    let reply = try await credentialReply("/sign-up/email", body: ["name": name, "email": email, "password": password,
      "callbackURL": Self.authOrigin + "/api/auth/mobile/email-verified"])
    let object = try Self.record(Self.json(reply.data))
    if reply.token != nil || object["token"] is String { return try Self.sessionToken(reply) }
    guard (object["token"] == nil || object["token"] is NSNull),
          let user = object["user"] as? [String: Any], let id = user["id"] as? String, !id.isEmpty else {
      throw AuthFailure(message: String(localized: "auth.error.invalidResponse", bundle: .lody))
    }
    try await resendVerification(email: email)
    return nil
  }

  func resendVerification(email: String) async throws {
    let reply = try await credentialReply("/send-verification-email", body: ["email": email,
      "callbackURL": Self.authOrigin + "/api/auth/mobile/email-verified"])
    let object = try Self.record(Self.json(reply.data))
    guard object["status"] as? Bool == true else {
      throw AuthFailure(message: String(localized: "auth.native.failed", bundle: .lody))
    }
  }

  private func credentialReply(_ path: String, body: [String: Any], native: Bool = false) async throws -> Reply {
    let endpoint = native ? path : "/api/auth" + path
    var request = URLRequest(url: URL(string: Self.authOrigin + endpoint)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let reply = try await loginTransport(request)
    try Task.checkCancellation()
    guard (200..<300).contains(reply.status) else {
      throw AuthFailure(message: String(localized: "auth.native.failed", bundle: .lody))
    }
    return reply
  }

  private static func sessionToken(_ reply: Reply) throws -> String {
    let object = try Self.record(Self.json(reply.data))
    // Streams authorization looks up the raw session token. Better Auth's
    // set-auth-token header is a signed cookie value, not that database token.
    let token = try Self.requiredString(object["token"])
    guard !token.contains(where: { $0.isWhitespace || $0.isNewline }) else {
      throw AuthFailure(message: String(localized: "auth.error.invalidResponse", bundle: .lody))
    }
    return token
  }

  func requestPasswordReset(email: String) async throws {
    guard Self.authOrigin == "https://backend.lody.ai" else {
      throw AuthFailure(message: String(localized: "auth.reset.unsupportedLocal", bundle: .lody))
    }
    try await passwordAction("/request-password-reset", body: ["email": email, "redirectTo": "https://lody.ai/reset-password"])
  }

  private func passwordAction(_ path: String, body: [String: Any]) async throws {
    var request = URLRequest(url: URL(string: Self.authOrigin + "/api/auth" + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let reply = try await loginTransport(request)
    try Task.checkCancellation()
    guard (200..<300).contains(reply.status),
          let value = try? Self.record(Self.json(reply.data)), value["status"] as? Bool == true else {
      throw AuthFailure(message: String(localized: "auth.reset.failed", bundle: .lody))
    }
  }

  func account(token: String) async throws -> AuthAccount {
    let session = try await request("/get-session", token: token)
    if session is NSNull { throw Self.expired }
    let user = try Self.record(Self.record(session)["user"])
    guard let list = try await request("/organization/list", token: token) as? [Any] else {
      throw AuthFailure(message: String(localized: "auth.error.invalidWorkspaceList", bundle: .lody))
    }
    let email = try Self.requiredString(user["email"])
    return AuthAccount(
      user: AuthUser(
        id: try Self.requiredString(user["id"]),
        name: user["name"] as? String ?? email,
        email: email,
        image: Self.optionalHTTPS(user["image"])
      ),
      workspaces: try list.map(Self.workspace)
    )
  }

  func updateWorkspace(token: String, id: String, name: String) async throws -> AuthWorkspace {
    try Self.workspace(await request("/organization/update", token: token, body: ["organizationId": id, "data": ["name": name]]))
  }

  func updateWorkspaceIcon(token: String, id: String, image: String) async throws -> AuthWorkspace {
    try Self.workspace(await request("/organization/update", token: token, body: ["organizationId": id, "data": ["logo": image]]))
  }

  func uploadWorkspaceIcon(token: String, id: String, file: WorkspaceIconFile) async throws -> String {
    guard Self.iconTypes.contains(file.type), file.size > 0, file.size <= Self.iconMaxBytes else {
      throw AuthFailure(message: String(localized: "workspace.edit.invalidIcon", bundle: .lody))
    }
    guard file.url.isFileURL, let contents = try? Data(contentsOf: file.url) else {
      throw AuthFailure(message: String(localized: "workspace.edit.iconUploadFailed", bundle: .lody))
    }
    let boundary = "lody-\(UUID().uuidString)"
    let filename = file.name.replacingOccurrences(of: "\"", with: "%22")
    var body = Data()
    body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\nworkspace\r\n".utf8))
    body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: \(file.type)\r\n\r\n".utf8))
    body.append(contents)
    body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    var request = URLRequest(url: URL(string: "\(Self.cloudOrigin)/api/workspaces/\(Self.component(id))/avatars/upload")!)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    let (data, status) = try await transport(request)
    let value = try Self.json(data)
    if status == 401 { throw Self.expired }
    guard (200..<300).contains(status) else { throw AuthFailure(message: String(localized: "workspace.edit.iconUploadFailed", bundle: .lody)) }
    let avatar = try Self.record(Self.record(value)["avatar"])
    return "\(Self.cloudOrigin)/api/avatars/\(Self.component(try Self.requiredString(avatar["avatarId"])))"
  }

  func members(token: String, workspaceId: String) async throws -> [WorkspaceMember] {
    guard workspaceId.range(of: #"^[A-Za-z0-9_-]{1,200}$"#, options: .regularExpression) != nil else {
      throw AuthFailure(message: "Invalid workspace")
    }
    var members: [String: WorkspaceMember] = [:]
    var offset = 0
    while offset < 10000 {
      try Task.checkCancellation()
      let page = try Self.record(await request("/organization/list-members?organizationId=\(workspaceId)&limit=100&offset=\(offset)", token: token))
      guard let rows = page["members"] as? [[String: Any]], rows.count <= 100,
            let total = page["total"] as? Int, (0...10000).contains(total) else { throw AuthFailure(message: "Invalid members") }
      for row in rows {
        let id = try Self.requiredString(row["userId"])
        let user = try Self.record(row["user"] as Any)
        guard user["id"] as? String == id else { throw AuthFailure(message: "Invalid member identity") }
        members[id] = WorkspaceMember(id: id, name: user["name"] as? String ?? "", image: Self.optionalHTTPS(user["image"]))
      }
      offset += rows.count
      if offset >= total { return members.values.sorted { $0.id < $1.id } }
      guard !rows.isEmpty else { throw AuthFailure(message: "Incomplete members") }
    }
    throw AuthFailure(message: "Too many members")
  }

  func signOut(token: String) async throws {
    _ = try await request("/sign-out", token: token, body: [:])
  }

  private func request(_ path: String, token: String? = nil, body: [String: Any]? = nil) async throws -> Any {
    var request = URLRequest(url: URL(string: "\(Self.authOrigin)/api/auth\(path)")!)
    request.httpMethod = body == nil ? "GET" : "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
    let (data, status) = try await transport(request)
    let value = try Self.json(data)
    if status == 401 { throw Self.expired }
    if !(200..<300).contains(status) {
      throw AuthFailure(message: String.localizedStringWithFormat(String(localized: "auth.error.requestFailed", bundle: .lody), String(describing: status)))
    }
    return value
  }

  private static var expired: AuthFailure {
    AuthFailure(message: String(localized: "auth.error.expired", bundle: .lody), expired: true)
  }

  private static func json(_ data: Data) throws -> Any {
    do { return try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) }
    catch { throw AuthFailure(message: String(localized: "auth.error.invalidResponse", bundle: .lody)) }
  }

  private static func record(_ value: Any?) throws -> [String: Any] {
    guard let value = value as? [String: Any] else { throw AuthFailure(message: String(localized: "auth.error.invalidResponse", bundle: .lody)) }
    return value
  }

  private static func requiredString(_ value: Any?) throws -> String {
    guard let value = value as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw AuthFailure(message: String(localized: "auth.error.missingFields", bundle: .lody))
    }
    return value
  }

  static func optionalHTTPS(_ value: Any?) -> String? {
    guard let value = value as? String, value.hasPrefix("https://"), var url = URLComponents(string: value),
          url.user == nil, url.password == nil, let host = url.host, !host.isEmpty else { return nil }
    url.host = host.lowercased()
    if url.path.isEmpty { url.path = "/" }
    return url.url?.absoluteString
  }

  private static func workspace(_ value: Any) throws -> AuthWorkspace {
    let item = try record(value)
    return AuthWorkspace(
      id: try requiredString(item["id"]),
      name: try requiredString(item["name"]),
      slug: item["slug"] as? String,
      image: optionalHTTPS(item["logo"])
    )
  }

  private static func component(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: componentCharacters) ?? value
  }
}
