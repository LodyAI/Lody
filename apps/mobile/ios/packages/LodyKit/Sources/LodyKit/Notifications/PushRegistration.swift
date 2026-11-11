import Foundation

/// Serializes client installation operations and fences stale local completions.
/// A transport timeout does not establish server commit order; cleanup is best effort.
@MainActor
final class PushRegistration {
  struct Session: Equatable {
    let user: String
    let credential: String
    let installation: String
  }
  enum Provider { case oneSignal, apns }
  struct Configuration: Decodable { let selfHostedEnabled: Bool }
  typealias Call = (Session, String, String, [String: String]) async throws -> Data
  private let installation: String
  private let call: Call
  private let changed: (Provider?, Bool) -> Void
  private let failure: () -> Void
  private(set) var session: Session?
  private(set) var provider: Provider?
  private var generation = 0
  private var tail: Task<Void, Never>?
  private var token: String?
  var hasDeviceToken: Bool { token?.isEmpty == false }
  private var bundle: String?
  private(set) var authorized = false

  init(installation: String, call: @escaping Call, changed: @escaping (Provider?, Bool) -> Void, failure: @escaping () -> Void) {
    self.installation = installation
    self.call = call; self.changed = changed; self.failure = failure
  }

  func identify(user: String?, credential: String?) {
    if session?.user == user, session?.credential == credential { return }
    let old = session
    generation += 1
    session = nil; provider = nil; authorized = false
    changed(nil, false)
    if let old { enqueue { await self.remove(old) } }
    if let user, !user.isEmpty, let credential, !credential.isEmpty {
      session = Session(user: user, credential: credential, installation: installation)
    }
  }

  /// Returns false for a repeated callback with the same token and Bundle ID.
  @discardableResult
  func deviceToken(_ token: String, bundle: String?) -> Bool {
    guard self.token != token || self.bundle != bundle else { return false }
    self.token = token; self.bundle = bundle
    return true
  }

  func refresh(authorized: Bool) {
    self.authorized = authorized
    if !authorized { changed(provider, false) }
    guard let session else { return }
    generation += 1
    let epoch = generation
    enqueue {
      guard self.current(session, epoch) else { return }
      if !self.authorized { await self.remove(session) }
      guard self.current(session, epoch) else { return }
      do {
        let data = try await self.call(session, "query", "pushSubscriptions:configuration", [:])
        let config = try JSONDecoder().decode(Configuration.self, from: data)
        guard self.current(session, epoch) else { return }
        let next: Provider = config.selfHostedEnabled ? .apns : .oneSignal
        self.provider = next
        self.changed(next, false)
        if next == .oneSignal || !self.authorized {
          // Also retire a binding left by a previous process.
          if self.authorized { await self.remove(session) }
          return
        }
        guard let token = self.token, !token.isEmpty, let bundle = self.bundle, !bundle.isEmpty else { return }
        _ = try await self.call(session, "mutation", "pushSubscriptions:register", [
          "installationId": session.installation, "platform": "ios", "purpose": "notification",
          "token": token, "bundleId": bundle, "language": Locale.preferredLanguages.first ?? "en",
        ])
        guard self.current(session, epoch) else { return }
        self.changed(next, true)
      } catch {
        if self.current(session, epoch) { self.failure() }
      }
    }
  }

  private func current(_ session: Session, _ epoch: Int) -> Bool {
    self.session == session && generation == epoch
  }
  private func remove(_ session: Session) async {
    do { _ = try await call(session, "mutation", "pushSubscriptions:unregister", ["installationId": session.installation]) }
    catch { failure() }
  }
  private func enqueue(_ work: @escaping @MainActor () async -> Void) {
    let previous = tail
    tail = Task { await previous?.value; await work() }
  }
  // Deterministic lifecycle checks await real completion, never sleeps.
  func drain() async { await tail?.value }
}
