import Foundation

enum NativeLoginMethod: Sendable {
  case email(String, String)
  case register(String, String, String)
  case resendVerification(String)
  case apple, google, github, discord
}

/// The sign-in method this device last completed, shown as "Last used" (web
/// `last-login-method.ts`). Display only: it never selects or starts a method.
enum NativeLastLoginMethod: String, CaseIterable, Sendable {
  case github, google, apple, discord, email

  private static let key = "lody.auth.lastLoginMethod"

  init?(_ method: NativeLoginMethod) {
    switch method {
    case .email, .register: self = .email
    case .resendVerification: return nil
    case .apple: self = .apple
    case .google: self = .google
    case .github: self = .github
    case .discord: self = .discord
    }
  }

  static func read(_ defaults: UserDefaults = .standard) -> NativeLastLoginMethod? {
    defaults.string(forKey: key).flatMap(NativeLastLoginMethod.init(rawValue:))
  }

  func write(_ defaults: UserDefaults = .standard) {
    defaults.set(rawValue, forKey: Self.key)
  }
}
