import AuthenticationServices
import CryptoKit
import GoogleSignIn
import UIKit

@MainActor
final class NativeAuthProviders: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding, ASWebAuthenticationPresentationContextProviding {
  private var apple: ASAuthorizationController?
  private var appleReply: CheckedContinuation<(token: String, name: [String: String]?), Error>?
  private var browser: ASWebAuthenticationSession?
  private var browserReply: CheckedContinuation<URL, Error>?
  private var window: UIWindow?
  private var browserID = UUID()
  private var googleID = UUID()
  private var googleReply: CheckedContinuation<String, Error>?

  func cancel() {
    googleID = UUID()
    googleReply?.resume(throwing: CancellationError())
    googleReply = nil
    GIDSignIn.sharedInstance.signOut()
    apple?.cancel()
    apple = nil
    appleReply?.resume(throwing: CancellationError())
    appleReply = nil
    browserID = UUID()
    browser?.cancel()
    browser = nil
    browserReply?.resume(throwing: CancellationError())
    browserReply = nil
  }

  func signIn(_ method: NativeLoginMethod, presenting controller: UIViewController, api: AuthAPI) async throws -> String {
    try Task.checkCancellation()
    window = controller.view.window
    guard window != nil else { throw CancellationError() }
    switch method {
    case .apple:
      let nonce = try NativeAuthHandoff.random()
      let request = ASAuthorizationAppleIDProvider().createRequest()
      request.requestedScopes = [.email, .fullName]
      request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
      let token = try await withCheckedThrowingContinuation { continuation in
        appleReply = continuation
        let authorization = ASAuthorizationController(authorizationRequests: [request])
        apple = authorization
        authorization.delegate = self
        authorization.presentationContextProvider = self
        authorization.performRequests()
      }
      try Task.checkCancellation()
      return try await api.idToken(provider: "apple", token: token.token, nonce: nonce, name: token.name)
    case .google:
      guard let client = Self.configuration("GIDClientID"), let server = Self.configuration("GIDServerClientID"),
            Self.hasGoogleCallback(clientID: client) else {
        throw AuthFailure(message: String(localized: "auth.native.googleConfiguration", bundle: .lody))
      }
      GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: client, serverClientID: server)
      let token: String = try await withCheckedThrowingContinuation { continuation in
        let id = UUID()
        googleID = id
        googleReply = continuation
        GIDSignIn.sharedInstance.signIn(withPresenting: controller) { [weak self] result, error in
          guard let self else { return }
          guard self.googleID == id, let reply = self.googleReply else {
            if self.googleReply == nil { GIDSignIn.sharedInstance.signOut() }
            return
          }
          self.googleReply = nil
          let token = result?.user.idToken?.tokenString
          GIDSignIn.sharedInstance.signOut()
          if let token, !token.isEmpty { reply.resume(returning: token) }
          else if let error = error as NSError?, error.domain == kGIDSignInErrorDomain,
                  error.code == GIDSignInErrorCode.canceled.rawValue { reply.resume(throwing: CancellationError()) }
          else { reply.resume(throwing: AuthFailure(message: String(localized: "auth.native.failed", bundle: .lody))) }
        }
      }
      try Task.checkCancellation()
      return try await api.idToken(provider: "google", token: token)
    case .github, .discord:
      let provider = method.provider
      let handoff = try NativeAuthHandoff()
      let url = try handoff.startURL(provider: provider)
      try Task.checkCancellation()
      let callback: URL = try await withCheckedThrowingContinuation { continuation in
        browserReply = continuation
        let id = UUID()
        browserID = id
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "lody") { [weak self] url, error in
          Task { @MainActor in
            guard let self, self.browserID == id, let reply = self.browserReply else { return }
            self.browserReply = nil
            self.browser = nil
            if let url { reply.resume(returning: url) }
            else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { reply.resume(throwing: CancellationError()) }
            else { reply.resume(throwing: AuthFailure(message: String(localized: "auth.native.failed", bundle: .lody))) }
          }
        }
        browser = session
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = true
        if !session.start() {
          browser = nil
          browserReply = nil
          continuation.resume(throwing: AuthFailure(message: String(localized: "auth.native.failed", bundle: .lody)))
        }
      }
      try Task.checkCancellation()
      return try await api.exchangeHandoff(code: handoff.code(from: callback), handoff: handoff)
    case .email, .register, .resendVerification: throw CancellationError()
    }
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { window! }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window! }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    guard controller === apple, let reply = appleReply else { return }
    appleReply = nil
    apple = nil
    if let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
       let data = credential.identityToken, let token = String(data: data, encoding: .utf8), !token.isEmpty {
      var name: [String: String] = [:]
      if let first = credential.fullName?.givenName, !first.isEmpty { name["firstName"] = first }
      if let last = credential.fullName?.familyName, !last.isEmpty { name["lastName"] = last }
      reply.resume(returning: (token, name.isEmpty ? nil : name))
    } else { reply.resume(throwing: AuthFailure(message: String(localized: "auth.error.invalidResponse", bundle: .lody))) }
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    guard controller === apple, let reply = appleReply else { return }
    appleReply = nil
    apple = nil
    if (error as? ASAuthorizationError)?.code == .canceled { reply.resume(throwing: CancellationError()) }
    else { reply.resume(throwing: AuthFailure(message: String(localized: "auth.native.failed", bundle: .lody))) }
  }

  private static func hasGoogleCallback(clientID: String) -> Bool {
    guard clientID.hasSuffix(".apps.googleusercontent.com") else { return false }
    let reversed = clientID.split(separator: ".").reversed().joined(separator: ".")
    let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
    return types.contains { ($0["CFBundleURLSchemes"] as? [String] ?? []).contains(reversed) }
  }

  private static func configuration(_ key: String) -> String? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
          !value.isEmpty, !value.contains("$(") else { return nil }
    return value
  }
}

private extension NativeLoginMethod {
  var provider: String {
    switch self {
    case .github: return "github"
    case .discord: return "discord"
    default: return ""
    }
  }
}
