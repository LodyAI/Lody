import UIKit

@MainActor
final class OnboardingPreviewController: OnboardingController {
  init() {
    let fixture = OnboardingFixture()
    super.init(service: fixture.service())
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

@MainActor
private final class OnboardingFixture {
  private enum Phase { case idle, waiting, error, signedIn }

  private static let changed = Notification.Name("LodyOnboardingPreviewDidChange")
  private var phase = Phase.idle

  func service() -> OnboardingService {
    OnboardingService(
      changes: [Self.changed],
      state: { [self] in state },
      login: { [self] _ in move([.idle: .waiting, .waiting: .waiting, .error: .signedIn, .signedIn: .signedIn][phase] ?? phase) },
      cancel: { [self] in move(.error) }
    )
  }

  private var state: OnboardingState {
    OnboardingState(
      signedIn: phase == .signedIn,
      busy: phase == .waiting,
      error: phase == .error ? String(localized: "auth.error.cancelledSignIn", bundle: .lody) : nil
    )
  }

  private func move(_ next: Phase) {
    phase = next
    NotificationCenter.default.post(name: Self.changed, object: nil)
  }

}
