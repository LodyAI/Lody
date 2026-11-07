import SafariServices
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
      login: { [self] in move([.idle: .waiting, .waiting: .waiting, .error: .signedIn, .signedIn: .signedIn][phase] ?? phase) },
      cancel: { [self] in move(.error) },
      reopen: { [self] in authorizeInBrowser() }
    )
  }

  private var state: OnboardingState {
    OnboardingState(
      signedIn: phase == .signedIn,
      busy: phase == .waiting,
      code: phase == .waiting ? "WXYZ-1234" : nil,
      error: phase == .error ? String(localized: "auth.error.cancelledSignIn", bundle: .lody) : nil
    )
  }

  private func move(_ next: Phase) {
    phase = next
    NotificationCenter.default.post(name: Self.changed, object: nil)
  }

  private func authorizeInBrowser() {
    guard phase == .waiting, let presenter = LodyShell.shared.presenter else { return }
    // Exercise the real modal hierarchy without loading Cloud or using credentials.
    let browser = SFSafariViewController(url: URL(string: "http://127.0.0.1:9")!)
    presenter.present(browser, animated: true) { [self] in
      // Match AuthSession: publish the account while Safari still covers onboarding,
      // then close the owned browser. The welcome sheet must close as well.
      move(.signedIn)
      browser.dismiss(animated: true)
    }
  }
}
