import CryptoKit
import Foundation
import Security

/// Attempt-local proof. Neither verifier nor session credentials enter the browser URL.
struct NativeAuthHandoff: Sendable {
  static let redirectURI = "lody://auth/mobile-callback"
  let state: String
  let verifier: String

  init() throws {
    state = try Self.random()
    verifier = try Self.random()
  }

  init(state: String, verifier: String) {
    self.state = state
    self.verifier = verifier
  }

  var challenge: String { Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }

  func startURL(provider: String) throws -> URL {
    guard ["github", "discord"].contains(provider) else { throw Self.invalid }
    var url = URLComponents(string: AuthAPI.authOrigin + "/api/auth/mobile/start")!
    url.queryItems = [
      URLQueryItem(name: "provider", value: provider),
      URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "code_challenge", value: challenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
    ]
    guard let result = url.url else { throw Self.invalid }
    return result
  }

  func code(from callback: URL) throws -> String {
    guard let url = URLComponents(url: callback, resolvingAgainstBaseURL: false),
          url.scheme == "lody", url.host == "auth", url.path == "/mobile-callback",
          url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
          let items = url.queryItems, Set(items.map(\.name)).count == items.count,
          Set(items.map(\.name)).isSubset(of: ["code", "state", "error"]),
          items.first(where: { $0.name == "state" })?.value == state else { throw Self.invalid }
    if items.contains(where: { $0.name == "error" }) { throw Self.invalid }
    guard let code = items.first(where: { $0.name == "code" })?.value,
          !code.isEmpty, code.count <= 512,
          code.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_").contains($0) }) else { throw Self.invalid }
    return code
  }

  static func random() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw invalid }
    return base64url(Data(bytes))
  }

  private static func base64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private static var invalid: AuthFailure {
    AuthFailure(message: String(localized: "auth.native.failed", bundle: .lody))
  }
}

extension AuthAPI {
  func exchangeHandoff(code: String, handoff: NativeAuthHandoff) async throws -> String {
    try await authenticate("/api/auth/mobile/exchange", body: [
      "code": code, "code_verifier": handoff.verifier, "redirect_uri": NativeAuthHandoff.redirectURI,
    ], native: true)
  }
}
