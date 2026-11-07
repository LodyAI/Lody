import Foundation

struct OnboardingState: Equatable {
  var signedIn = false
  var busy = false
  var error: String?
}

@MainActor
struct OnboardingService {
  var changes: [Notification.Name]
  var state: () -> OnboardingState
  var login: (NativeLoginMethod) -> Void
  var cancel: () -> Void

  static var live: OnboardingService {
    OnboardingService(
      changes: [.lodyAuthDidChange],
      state: {
        let auth = AuthSession.shared.snapshot
        return OnboardingState(signedIn: auth.account != nil, busy: auth.busy, error: auth.error)
      },
      login: { method in Task { await AuthSession.shared.login(method) } },
      cancel: { AuthSession.shared.cancel() }
    )
  }
}
