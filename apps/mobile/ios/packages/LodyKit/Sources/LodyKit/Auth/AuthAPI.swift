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

struct DeviceCode: Sendable {
  let deviceCode: String
  let userCode: String
  let verificationURL: String
  let expiresIn: Double
  let interval: Double
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

  static let authOrigin = "https://backend.lody.ai"
  static let cloudOrigin = "https://api.lody.ai"
  static let clientID = "lody-cli"
  private static let iconTypes: Set<String> = ["image/png", "image/jpeg", "image/webp", "image/gif"]
  private static let iconMaxBytes = 1024 * 1024
  private static let componentCharacters = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
  )
  private static let session: URLSession = {
    let configuration = URLSessionConfiguration.default
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpCookieStorage = nil
    return URLSession(configuration: configuration)
  }()

  var transport: Transport = { request in
    do {
      let (data, response) = try await AuthAPI.session.data(for: request)
      return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    } catch let error as URLError where error.code != .cancelled {
      throw AuthFailure(message: "Network request failed")
    }
  }
  var sleep: @Sendable (Double) async throws -> Void = { milliseconds in
    try await Task.sleep(nanoseconds: UInt64(max(0, milliseconds) * 1_000_000))
  }
  var now: @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }

  func deviceCode() async throws -> DeviceCode {
    let data = try Self.record(await request("/device/code", body: ["client_id": Self.clientID]))
    let address = try Self.requiredString(data["verification_uri_complete"])
    guard var url = URLComponents(string: address), url.scheme?.lowercased() == "https",
          let host = url.host?.lowercased(), ["lody.ai", "backend.lody.ai"].contains(host),
          url.port == nil || url.port == 443, url.user == nil, url.password == nil else {
      throw AuthFailure(message: String(localized: "auth.error.invalidAuthorizeUrl", bundle: .lody))
    }
    guard let expiresIn = Self.positive(data["expires_in"]), let interval = Self.positive(data["interval"]) else {
      throw AuthFailure(message: String(localized: "auth.error.invalidExpiry", bundle: .lody))
    }
    // The auth site redirects to this official web UI; match the CLI's direct device-page link.
    url.scheme = "https"
    url.host = "lody.ai"
    url.port = nil
    if url.path.isEmpty { url.path = "/" }
    guard let verification = url.url?.absoluteString else { throw AuthFailure(message: String(localized: "auth.error.invalidAuthorizeUrl", bundle: .lody)) }
    return DeviceCode(
      deviceCode: try Self.requiredString(data["device_code"]),
      userCode: try Self.requiredString(data["user_code"]),
      verificationURL: verification,
      expiresIn: expiresIn,
      interval: interval
    )
  }

  func pollToken(_ code: DeviceCode) async throws -> String {
    var interval = code.interval * 1000
    let deadline = now() + code.expiresIn * 1000
    polling: while now() < deadline {
      try await sleep(min(interval, deadline - now()))
      try Task.checkCancellation()
      if now() >= deadline { break }
      let data = try Self.record(await request("/device/token", body: [
        "client_id": Self.clientID,
        "device_code": code.deviceCode,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
      ]))
      if let token = data["access_token"] as? String, !token.isEmpty { return token }
      switch data["error"] as? String {
      case "authorization_pending": continue
      case "slow_down": interval += 5000
      case "access_denied": throw AuthFailure(message: String(localized: "auth.error.accessDenied", bundle: .lody))
      case "expired_token": break polling
      default: throw AuthFailure(message: String(localized: "auth.error.deviceAuthFailed", bundle: .lody))
      }
    }
    throw AuthFailure(message: String(localized: "auth.error.codeExpired", bundle: .lody))
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
    if !(200..<300).contains(status), path != "/device/token" {
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

  private static func positive(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue > 0 else { return nil }
    return number.doubleValue
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
