import Foundation
import MetalKit
import UIKit

// Compile the production AuthSession against deterministic external boundaries.
// No real credential, provider UI, runtime or database is accessed by this check.
@MainActor enum AuthKeychain {
  static var token: String?
  static func read() throws -> String? { token }
  static func save(_ value: String) throws { token = value }
  static func clear() throws { token = nil }
}
@MainActor final class NativeAuthProviders {
  func cancel() {}
  func signIn(_ method: NativeLoginMethod, presenting: UIViewController, api: AuthAPI) async throws -> String { throw CancellationError() }
}
enum LodyUIVerify { static let enabled = false; static let offline = false }
struct AuthCatalogScope {
  var account: AuthAccount?
  var localReady: Bool
  var initialWorkspace: String
  var initialCatalog: String?
}
@MainActor enum ShareStore { static func clear() {} }
@MainActor final class PushNotifications {
  static let shared = PushNotifications()
  func identify(_ value: String?, credential: String? = nil) {}
}
enum LodyToastKind { case error }
@MainActor final class LodyToastOverlay {
  static let shared = LodyToastOverlay()
  func show(message: String, kind: LodyToastKind) {}
}
final class LocalStore: @unchecked Sendable {
  static let shared = LocalStore()
  static let queue = DispatchQueue(label: "auth-session-fixture")
  var generation = 0
  var clearHook: (@Sendable () -> Void)?
  var writeHook: (@Sendable () -> Void)?
  func startup() throws -> [String: String] { [:] }
  func clear() throws { clearHook?(); generation += 1 }
  func write(_ key: String, _ value: String, generation: Int?) throws { writeHook?() }
}

@MainActor final class LodyShell {
  static let shared = LodyShell()
  var finished = false
  func finish(from: UIViewController, value: String?) { finished = true }
  func close(from: UIViewController) {}
  func presentNative(_ content: UIViewController, title: String) {}
}
@MainActor enum LodyScrollEdges {
  static func bind(_ scroll: UIScrollView, to: UIViewController) {}
}

actor ModeRefreshGate {
  private var waiting: CheckedContinuation<Void, Never>?
  private var entered: CheckedContinuation<Void, Never>?
  private var hasEntered = false
  func wait() async {
    hasEntered = true; entered?.resume(); entered = nil
    await withCheckedContinuation { waiting = $0 }
  }
  func started() async { if hasEntered { return }; await withCheckedContinuation { entered = $0 } }
  func release() { waiting?.resume(); waiting = nil }
}

@main struct AuthSessionCheck {
  @MainActor static func main() async throws {
    let visual = LoginDitherView(frame: CGRect(x: 0, y: 0, width: 378, height: 360))
    visual.layoutIfNeeded()
    let metal = visual.subviews.compactMap { $0 as? MTKView }.first
    precondition(metal != nil, "The login Metal shader must compile on the simulator")
    let drawableSize = metal!.drawableSize
    precondition(drawableSize == CGSize(width: 126, height: 120), "Login dither uses 3 pt cells")
    visual.frame.size.height = 0
    visual.setNeedsLayout()
    visual.layoutIfNeeded()
    precondition(metal!.drawableSize == drawableSize,
                 "Folding to email must retain the drawable until the visible surface finishes clipping")
    visual.frame.size.height = 300
    visual.setNeedsLayout()
    visual.layoutIfNeeded()
    precondition(metal!.drawableSize == CGSize(width: 126, height: 100),
                 "Reopening the login visual must resize to its new visible bounds")
    print("PASS: login Metal compiles and folding retains whole-cell rendering")
    let session = AuthSession()
    session.api.loginTransport = { _ in AuthAPI.Reply(data: Data("{\"token\":\"synthetic-session\"}".utf8), status: 200, token: "synthetic-session.synthetic-signature") }
    session.api.transport = { request in
      if request.url?.path.hasSuffix("get-session") == true {
        return (Data("{\"user\":{\"id\":\"synthetic-user\",\"name\":\"Tester\",\"email\":\"test@example.test\"}}".utf8), 200)
      }
      return (Data("[]".utf8), 200)
    }
    // Cancel exactly while the store clear is suspended, not based on timing.
    let releaseClear = DispatchSemaphore(value: 0)
    var login: Task<Void, Never>!
    await withCheckedContinuation { (entered: CheckedContinuation<Void, Never>) in
      LocalStore.shared.clearHook = { entered.resume(); releaseClear.wait() }
      login = Task { await session.login(.email("test@example.test", "synthetic-password")) }
    }
    session.cancel()
    releaseClear.signal()
    await login.value
    precondition(AuthKeychain.token == nil && session.snapshot.account == nil,
                 "Cancellation during local clear must never write a stale Keychain credential")
    LocalStore.shared.clearHook = nil

    let releaseSave = DispatchSemaphore(value: 0)
    await withCheckedContinuation { (entered: CheckedContinuation<Void, Never>) in
      LocalStore.shared.writeHook = { entered.resume(); releaseSave.wait() }
      login = Task { await session.login(.email("test@example.test", "synthetic-password")) }
    }
    session.cancel()
    releaseSave.signal()
    await login.value
    precondition(AuthKeychain.token == nil && session.snapshot.account == nil,
                 "Cancellation during account persistence must never publish or save credentials")
    LocalStore.shared.writeHook = nil

    await session.login(.email("test@example.test", "synthetic-password"))
    precondition(AuthKeychain.token == "synthetic-session" && session.snapshot.account?.user.id == "synthetic-user",
                 "A later explicit sign-in must install the raw session token needed by Streams, not the signed cookie header")
    await session.logout()
    precondition(AuthKeychain.token == nil && session.snapshot.account == nil,
                 "Sign-out removes the credential and signed-in projection")
    await session.login(.register("Tester", "test@example.test", "synthetic-password"))
    precondition(AuthKeychain.token == "synthetic-session" && session.snapshot.account?.user.id == "synthetic-user",
                 "Registration credentials use the same validated account install path as sign-in")
    await session.logout()
    session.api.loginTransport = { request in
      if request.url?.path == "/api/auth/sign-up/email" {
        return AuthAPI.Reply(data: Data("{\"token\":null,\"user\":{\"id\":\"new-user\"}}".utf8), status: 200)
      }
      return AuthAPI.Reply(data: Data("{\"status\":true}".utf8), status: 200)
    }
    await session.login(.register("Tester", "test@example.test", "synthetic-password"))
    precondition(AuthKeychain.token == nil && session.snapshot.account == nil && !session.snapshot.busy,
                 "Verification-pending registration must not install a session")
    await session.login(.resendVerification("test@example.test"))
    precondition(AuthKeychain.token == nil && !session.snapshot.busy)
    print("PASS: registration shares session installation while verification-only actions remain signed out")
    var state = OnboardingState()
    var selected: NativeLoginMethod?
    let changed = Notification.Name("NativeLoginFixture")
    let page = OnboardingController(service: OnboardingService(changes: [changed], state: { state }, login: { selected = $0 }, cancel: { state.busy = false }))
    page.loadViewIfNeeded()
    func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
    let views = descendants(page.view)
    let email = views.first { $0.accessibilityIdentifier == "auth.native.email" } as! UITextField
    let password = views.first { $0.accessibilityIdentifier == "auth.native.password" } as! UITextField
    let submit = views.first { $0.accessibilityIdentifier == "auth-email-submit" } as! UIButton
    precondition(password.isSecureTextEntry && password.textContentType == .password)
    let entry = views.first { $0.accessibilityIdentifier == "auth-email-entry" } as! UIButton
    entry.sendActions(for: .touchUpInside)
    email.text = "person@example.test"
    password.text = "synthetic-password"
    submit.sendActions(for: .touchUpInside)
    if case let .email(address, secret) = selected {
      precondition(address == "person@example.test" && secret == "synthetic-password" && password.text?.isEmpty != false)
    } else { preconditionFailure("Native email controls must submit credentials to the session owner") }
    let toggle = views.first { $0.accessibilityIdentifier == "auth-registration-toggle" } as! UIButton
    toggle.sendActions(for: .touchUpInside)
    let name = views.first { $0.accessibilityIdentifier == "auth.native.name" } as! UITextField
    precondition(!name.isHidden && password.textContentType == .newPassword)
    name.text = "New User"
    // Web `validateNewPassword`: registration needs letters and numbers.
    selected = nil
    password.text = "synthetic-password"
    submit.sendActions(for: .touchUpInside)
    let error = views.first { $0.accessibilityIdentifier == "auth-error" } as! UILabel
    precondition(selected == nil && error.text == String(localized: "auth.login.passwordComplexity", bundle: .lody),
                 "Registration applies the shared password rules before any request")
    password.text = "synthetic-password-1"
    submit.sendActions(for: .touchUpInside)
    if case let .register(displayName, address, secret) = selected {
      precondition(displayName == "New User" && address == "person@example.test" && secret == "synthetic-password-1")
      precondition(password.text?.isEmpty != false)
    } else { preconditionFailure("Native registration must use the session owner") }
    state.verificationSent = true
    NotificationCenter.default.post(name: changed, object: nil)
    let body = views.first { $0.accessibilityIdentifier == "auth-verification-body" } as! UILabel
    precondition(body.superview?.isHidden == false && email.superview?.superview?.superview?.isHidden == true,
                 "A sent verification link replaces the email form with next steps")
    state.verificationSent = false
    let resend = views.first { $0.accessibilityIdentifier == "auth-verification-resend" } as! UIButton
    resend.sendActions(for: .touchUpInside)
    if case let .resendVerification(address) = selected { precondition(address == "person@example.test") }
    else { preconditionFailure("Verification resend must remain native") }
    state.busy = true
    NotificationCenter.default.post(name: changed, object: nil)
    precondition(!submit.isEnabled && !email.isEnabled && !password.isEnabled, "Pending sign-in prevents duplicate credential submission")
    state = OnboardingState(signedIn: true)
    NotificationCenter.default.post(name: changed, object: nil)
    precondition(LodyShell.shared.finished, "The native form closes only after account publication")
    print("PASS: native email form uses secure input, clears passwords and follows session-owned completion")
    let retrySession = AuthSession()
    let retryPins = WorkspaceModePins(file: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("pins.json"))
    retrySession.api.modePins = retryPins
    retrySession.api.loginTransport = { _ in AuthAPI.Reply(data: Data("{\"token\":\"mode-session\"}".utf8), status: 200) }
    retrySession.api.transport = { request in
      if request.url?.path.hasSuffix("get-session") == true { return (Data("{\"user\":{\"id\":\"mode-user\",\"email\":\"mode@example.test\"}}".utf8),200) }
      if request.url?.path.hasSuffix("organization/list") == true { return (Data("[{\"id\":\"target\",\"name\":\"Target\"}]".utf8),200) }
      return (Data("{}".utf8),503)
    }
    await retrySession.login(.email("mode@example.test", "synthetic-password"))
    precondition(retrySession.snapshot.account?.workspaces.first?.contentMode == .unknown)
    let gate = ModeRefreshGate()
    retrySession.api.transport = { request in
      if request.url?.path.hasSuffix("convex/token") == true { return (Data("{\"token\":\"jwt\"}".utf8),200) }
      await gate.wait()
      return (Data("{\"status\":\"success\",\"value\":{\"workspaceId\":\"target\",\"admission\":\"legacy-unclassified\"}}".utf8),200)
    }
    let refreshing = Task { await retrySession.refreshWorkspaceModes() }
    await gate.started()
    precondition(retrySession.snapshot.account?.user.id == "mode-user" && !retrySession.snapshot.busy && AuthKeychain.token == "mode-session", "A mode retry preserves account, credential and login UI")
    await gate.release(); await refreshing.value
    precondition(retrySession.snapshot.account?.workspaces.first?.contentMode == .plaintext)
    retrySession.api.transport = { _ in throw URLError(.notConnectedToInternet) }
    await retrySession.refreshWorkspaceModes()
    precondition(retrySession.snapshot.account?.user.id == "mode-user" && !retrySession.snapshot.busy && retrySession.snapshot.account?.workspaces.first?.contentMode == .plaintext)
    print("PASS: mode refresh preserves login/credentials while pending and keeps plaintext admission after offline failure")
    print("PASS: AuthSession fences cancelled Keychain commits and recovers for later login/logout")
  }
}
