import Foundation

struct OnboardingState: Equatable {
  var signedIn = false
  var busy = false
  var code: String?
  var error: String?

  var waiting: Bool { busy || code != nil }
}

@MainActor
struct OnboardingService {
  var changes: [Notification.Name]
  var state: () -> OnboardingState
  var login: () -> Void
  var cancel: () -> Void
  var reopen: () -> Void

  static var live: OnboardingService {
    OnboardingService(
      changes: [.lodyAuthDidChange],
      state: { published() },
      login: { Task { try? await AuthSession.shared.login() } },
      cancel: { AuthSession.shared.cancel() },
      reopen: { AuthSession.shared.reopen() }
    )
  }

  private static func published() -> OnboardingState {
    struct Code: Decodable { var user_code: String }
    struct Auth: Decodable {
      var account: AuthAccount?
      var busy: Bool?
      var code: Code?
      var error: String?
    }
    let auth = try? JSONDecoder().decode(Auth.self, from: Data(AuthSession.published.json.utf8))
    return OnboardingState(signedIn: auth?.account != nil, busy: auth?.busy ?? false, code: auth?.code?.user_code, error: auth?.error)
  }
}
