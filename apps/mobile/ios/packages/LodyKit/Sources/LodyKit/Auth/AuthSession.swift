import Foundation
import UIKit

struct AuthSnapshot: Encodable, Sendable {
  var account: AuthAccount?
  var busy = true
  var localReady = false
  var initialWorkspace = ""
  var catalogRevision = 0
  var error: String?

  var json: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }
}

final class AuthPublished: @unchecked Sendable {
  private let lock = NSLock()
  private var state = AuthSnapshot().json

  var json: String { lock.withLock { state } }

  fileprivate func set(_ json: String) -> Bool {
    lock.withLock {
      let changed = state != json
      state = json
      return changed
    }
  }
}

@MainActor
final class AuthSession {
  static let shared = AuthSession()
  nonisolated static let published = AuthPublished()

  private(set) var snapshot = AuthSnapshot()
  var api = AuthAPI()
  var presenter: (() -> UIViewController?)?
  var stopRuntime: (() -> Void)?

  private var account: AuthAccount?
  private var credential: String?
  private var busy = true
  private var localReady = false
  private var initialWorkspace = ""
  private var initialCatalog: String?
  private var catalogRevision = 0
  private var error: String?
  private var current: Task<Void, Never>?
  private var attempt = 0
  private var started = false
  private let providers = NativeAuthProviders()

  var catalogScope: AuthCatalogScope {
    AuthCatalogScope(account: account, localReady: localReady, initialWorkspace: initialWorkspace, initialCatalog: initialCatalog)
  }

  func start() {
    guard !started else { return }
    started = true
    Task { await restore() }
  }

  func restore() async {
    await begin { id in await self.performRestore(id) }
  }

  func login(_ method: NativeLoginMethod) async {
    guard !LodyUIVerify.enabled else { return }
    await begin { id in await self.performLogin(id, method: method) }
  }

  func cancel() {
    current?.cancel()
    attempt += 1
    providers.cancel()
    busy = false
    publish()
  }

  func logout() async {
    let token = credential
    await begin { id in await self.performLogout(id, token: token) }
  }

  func updateWorkspace(id: String, name: String) async throws {
    guard let account, let credential else { throw AuthFailure(message: String(localized: "workspace.edit.signedOut", bundle: .lody)) }
    let generation = LocalStore.shared.generation
    let updated = try await api.updateWorkspace(token: credential, id: id, name: name)
    await persist(updated, account: account, credential: credential, generation: generation)
  }

  func updateWorkspaceIcon(id: String, file: WorkspaceIconFile) async throws -> String {
    guard let account, let credential else { throw AuthFailure(message: String(localized: "workspace.edit.signedOut", bundle: .lody)) }
    let generation = LocalStore.shared.generation
    let image = try await api.uploadWorkspaceIcon(token: credential, id: id, file: file)
    let updated = try await api.updateWorkspaceIcon(token: credential, id: id, image: image)
    await persist(updated, account: account, credential: credential, generation: generation)
    return image
  }

  private func begin(_ work: @escaping @MainActor (Int) async -> Void) async {
    let previous = current
    previous?.cancel()
    providers.cancel()
    attempt += 1
    let id = attempt
    let task = Task {
      // Drain prior local persistence before admitting a replacement account.
      await previous?.value
      guard self.active(id) else { return }
      await work(id)
    }
    current = task
    await task.value
  }

  private func active(_ id: Int) -> Bool { id == attempt && !Task.isCancelled }

  private func update(_ id: Int, _ change: () -> Void) {
    guard active(id) else { return }
    change()
    publish()
  }

  private func setCatalog(_ raw: String?) {
    initialCatalog = raw
    catalogRevision += 1
  }

  private func performRestore(_ id: Int) async {
    if LodyUIVerify.enabled {
      update(id) { busy = false; localReady = true }
      return
    }
    update(id) { busy = true; error = nil }
    do {
      try await hydrateAndRefresh(id)
    } catch {
      if (error as? AuthFailure)?.expired == true, active(id) {
        update(id) { account = nil; credential = nil; setCatalog(nil) }
        if !(await clearLocalAndCredentials()) { toast("auth.toast.clearLocalFailed") }
      }
      update(id) { self.error = error.localizedDescription }
    }
    update(id) { busy = false; localReady = true }
  }

  private func hydrateAndRefresh(_ id: Int) async throws {
    let started = ProcessInfo.processInfo.systemUptime
    let token = try AuthKeychain.read()
    let boot = (try? await Self.onStore { try $0.startup() }) ?? [:]
    guard active(id) else { return }
    if let token, let saved = AuthAccount.decode(boot["account"]) {
      #if DEBUG
      NSLog("LodyLocal hydrate_ms=%.2f", (ProcessInfo.processInfo.systemUptime - started) * 1000)
      #endif
      update(id) {
        account = saved
        credential = token
        localReady = true
        initialWorkspace = boot["workspace"] ?? ""
        setCatalog(boot["catalog"])
      }
    } else {
      update(id) { localReady = true }
    }
    guard let token else {
      update(id) { account = nil; credential = nil }
      return
    }
    #if DEBUG
    // Match the native grant failure probe without changing product endpoints.
    if LodyUIVerify.offline { throw AuthFailure(message: "Network unavailable") }
    #endif
    let fresh = try await api.account(token: token)
    guard active(id) else { return }
    if let saved = AuthAccount.userID(boot["account"]), saved != fresh.user.id {
      try await clearLocal()
      update(id) { setCatalog(nil); initialWorkspace = "" }
    }
    await save(fresh)
    update(id) { account = fresh; credential = token }
  }

  private func performLogin(_ id: Int, method: NativeLoginMethod) async {
    update(id) { busy = true; error = nil }
    do {
      let token: String
      switch method {
      case let .email(email, password): token = try await api.email(email: email, password: password)
      case let .register(name, email, password):
        guard let registered = try await api.register(name: name, email: email, password: password) else {
          update(id) { busy = false; localReady = true; error = String(localized: "auth.native.verificationSent", bundle: .lody) }
          return
        }
        token = registered
      case let .resendVerification(email):
        try await api.resendVerification(email: email)
        update(id) { busy = false; localReady = true; error = String(localized: "auth.native.verificationSent", bundle: .lody) }
        return
      case .apple, .google, .github, .discord:
        guard let controller = presenter?() else { throw CancellationError() }
        token = try await providers.signIn(method, presenting: controller, api: api)
      }
      guard active(id) else { return }
      let fresh = try await api.account(token: token)
      guard active(id) else { return }
      try await clearLocal()
      // clearLocal suspends: cancellation must be rechecked BEFORE Keychain writes.
      guard active(id) else { return }
      await save(fresh)
      guard active(id) else { return }
      try AuthKeychain.save(token)
      update(id) { account = fresh; credential = token }
    } catch is CancellationError {
      // Cancellation is not an authentication error.
    } catch {
      update(id) { self.error = error.localizedDescription }
    }
    update(id) { busy = false; localReady = true }
  }

  private func performLogout(_ id: Int, token: String?) async {
    update(id) { busy = true; error = nil }
    update(id) { account = nil; credential = nil; setCatalog(nil) }
    do {
      guard await clearLocalAndCredentials() else { throw AuthFailure(message: String(localized: "auth.error.signOutIncomplete", bundle: .lody)) }
      if let token { try await api.signOut(token: token) }
    } catch {
      update(id) { self.error = String(localized: "auth.error.signOutIncomplete", bundle: .lody) }
    }
    update(id) { busy = false; localReady = true }
  }

  private func clearLocalAndCredentials() async -> Bool {
    var cleared = true
    do { try await clearLocal() } catch { cleared = false }
    do { try clearCredentials() } catch { cleared = false }
    return cleared
  }

  private func clearLocal() async throws {
    // Stop producers before clearing their queued writes, including background Sessions.
    stopRuntime?()
    ShareStore.clear()
    try await Self.onStore { try $0.clear() }
  }

  private func clearCredentials() throws {
    stopRuntime?()
    PushNotifications.shared.identify(nil)
    try AuthKeychain.clear()
  }

  private func save(_ account: AuthAccount, generation: Int? = nil) async {
    let json = account.json
    do { try await Self.onStore { try $0.write("account", json, generation: generation) } }
    catch { toast("auth.toast.accountSaveFailed") }
  }

  private func persist(_ updated: AuthWorkspace, account: AuthAccount, credential: String, generation: Int) async {
    let workspaces = account.workspaces.map { $0.id == updated.id ? updated : $0 }
    await save(AuthAccount(user: account.user, workspaces: workspaces), generation: generation)
    guard self.credential == credential, var current = self.account else { return }
    current.workspaces = workspaces
    self.account = current
    publish()
  }

  private func toast(_ key: String) {
    LodyToastOverlay.shared.show(message: String(localized: String.LocalizationValue(key), bundle: .lody), kind: "error")
  }

  private func publish() {
    snapshot = AuthSnapshot(
      account: account,
      busy: busy,
      localReady: localReady,
      initialWorkspace: initialWorkspace,
      catalogRevision: catalogRevision,
      error: error
    )
    guard Self.published.set(snapshot.json) else { return }
    NotificationCenter.default.post(name: .lodyAuthDidChange, object: nil)
  }

  private nonisolated static func onStore<T: Sendable>(_ body: @escaping @Sendable (LocalStore) throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      LocalStore.queue.async { continuation.resume(with: Result { try body(LocalStore.shared) }) }
    }
  }
}

extension Notification.Name {
  static let lodyAuthDidChange = Notification.Name("LodyAuthDidChange")
}
