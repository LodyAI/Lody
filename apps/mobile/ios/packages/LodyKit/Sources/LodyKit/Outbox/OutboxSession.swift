import Foundation
import UIKit

final class OutboxPublished: @unchecked Sendable {
  private let lock = NSLock()
  private var generation = 0
  private var values: [String: String] = [:]
  let inflight = OutboxInflight()

  func json(_ key: String, generation current: Int) -> String? {
    lock.withLock { generation == current ? values[key] : nil }
  }

  func set(_ key: String, _ json: String, generation current: Int) {
    lock.withLock {
      guard current >= generation else { return }
      if current > generation {
        values = [:]
        generation = current
      }
      values[key] = json
    }
  }
}

extension OutboxPersistence {
  static let local = OutboxPersistence(
    generation: { LocalStore.shared.generation },
    read: { key in
      await withCheckedContinuation { continuation in
        LocalStore.queue.async { continuation.resume(returning: (try? LocalStore.shared.read(key)) ?? nil) }
      }
    },
    write: { key, value, generation in
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        LocalStore.queue.async {
          continuation.resume(with: Result { try LocalStore.shared.write(key, value, generation: generation) })
        }
      }
    })
}

@MainActor
final class OutboxSession {
  static let shared = OutboxSession()
  nonisolated static let published = OutboxPublished()
  private nonisolated static let empty = #"{"ready":true,"records":[]}"#
  private nonisolated static let loading = #"{"ready":false,"records":[]}"#

  var presenter: (() -> UIViewController?)?
  private weak var runtime: DataRuntime?
  private let stores = OutboxStores(persistence: .local) { String(localized: "send.reason.awaitingConfirmation", bundle: .lody) }
  private lazy var dispatcher = OutboxDispatcher(services: services, inflight: Self.published.inflight) { String(localized: String.LocalizationValue($0), bundle: .lody) }
  private var scope = (user: "", workspace: "")
  private var inputs = OutboxDispatcher.Inputs()
  private var fixture: OutboxFixture?
  private var alertWindows: [UIWindow] = []

  private init() {
    stores.onChange = { [weak self] store in self?.changed(store) }
  }

  nonisolated static func read(user: String, workspace: String) -> String {
    let key = OutboxStores.key(user: user, workspace: workspace)
    guard !key.isEmpty else { return empty }
    if let json = published.json(key, generation: LocalStore.shared.generation) { return json }
    DispatchQueue.main.async {
      MainActor.assumeIsolated { _ = OutboxSession.shared.store(user: user, workspace: workspace) }
    }
    return loading
  }

  func attach(_ runtime: DataRuntime) {
    self.runtime = runtime
  }

  func catalogChanged(_ snapshot: CatalogSnapshot, latestUserMessages: [String: String]) {
    scope = (snapshot.userId, snapshot.workspaceId)
    inputs.userId = snapshot.userId
    inputs.connected = snapshot.connected && !snapshot.loading
    inputs.latestUserMessages = latestUserMessages
    inputs.catalogRevision = snapshot.catalogRevision
    dispatcher.update(store: store(user: scope.user, workspace: scope.workspace), inputs: inputs)
  }

  func setForeground(_ id: String) {
    guard inputs.foregroundSessionId != id else { return }
    inputs.foregroundSessionId = id
    dispatcher.update(store: store(user: scope.user, workspace: scope.workspace), inputs: inputs)
  }

  func leaveForeground(_ id: String) {
    if inputs.foregroundSessionId == id { setForeground("") }
  }

  func serverCreated(_ sessionId: String) -> Bool { inputs.latestUserMessages[sessionId] != nil }

  func outboxStore(user: String, workspace: String) -> OutboxStore? { store(user: user, workspace: workspace) }

  func pendingSessions(user: String, workspace: String, excluding server: [String: String]) -> [OutboxValue] {
    guard let store = store(user: user, workspace: workspace) else { return [] }
    return store.snapshot.records.filter { server[$0.sessionId] == nil }.map { .object($0.session) }
  }

  func allowsDeletion(_ payload: String) -> Bool {
    guard let args = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any],
          let workspace = args["workspaceId"] as? String, let ids = args["sessionIds"] as? [String],
          workspace == scope.workspace, let store = store(user: scope.user, workspace: workspace),
          store.snapshot.ready else { return false }
    return !store.snapshot.records.contains { ids.contains($0.sessionId) }
  }

  func put(user: String, workspace: String, json: String) -> Task<Void, Error> {
    guard let store = store(user: user, workspace: workspace) else { return Task { throw OutboxError.scopeExpired } }
    guard let record = OutboxRecord.decode(json), !record.sessionId.isEmpty else { return Task { throw OutboxError.invalidRecord } }
    return store.put(record)
  }

  func remove(user: String, workspace: String, sessionId: String) -> Task<Void, Error> {
    guard let store = store(user: user, workspace: workspace) else { return Task { throw OutboxError.scopeExpired } }
    return store.remove(sessionId)
  }

  func debugFixture(_ action: String) -> String {
    switch action {
    case "start":
      fixture?.stop()
      guard let store = store(user: OutboxFixture.user, workspace: OutboxFixture.workspace) else { return "{}" }
      fixture = OutboxFixture(store: store, alert: { [weak self] in self?.alert($0, $1) }) {
        NotificationCenter.default.post(name: .lodyOutboxDidChange, object: store)
      }
    case "stop":
      fixture?.stop()
      fixture = nil
    default:
      fixture?.perform(action)
    }
    return fixture?.state ?? "{}"
  }

  private func store(user: String, workspace: String) -> OutboxStore? {
    guard let store = stores.store(user: user, workspace: workspace) else { return nil }
    if Self.published.json(store.key, generation: store.generation) == nil {
      Self.published.set(store.key, store.json, generation: store.generation)
    }
    return store
  }

  private func changed(_ store: OutboxStore) {
    Self.published.set(store.key, store.json, generation: store.generation)
    NotificationCenter.default.post(name: .lodyOutboxDidChange, object: store)
    if store.key == OutboxStores.key(user: scope.user, workspace: scope.workspace) {
      CatalogSession.shared.outboxChanged()
      dispatcher.schedule()
    }
    fixture?.changed(store)
  }

  var services: OutboxServices {
    OutboxServices(
      createSession: { [weak self] payload in
        guard let runtime = self?.runtime else { throw OutboxError.scopeExpired }
        return try await withCheckedThrowingContinuation { runtime.createSession(payload, sink: .continuation($0)) }
      },
      ensureSession: { [weak self] id in
        guard let runtime = self?.runtime else { throw OutboxError.scopeExpired }
        _ = try await withCheckedThrowingContinuation { runtime.ensureSession(id, sink: .continuation($0)) }
      },
      sendSessionTurn: { [weak self] payload in
        guard let runtime = self?.runtime else { throw OutboxError.scopeExpired }
        return try await withCheckedThrowingContinuation { runtime.sendTurn(payload, sink: .continuation($0)) }
      },
      releaseReserve: { [weak self] id in self?.runtime?.releaseReserve(id) },
      alert: { [weak self] title, message in self?.alert(title, message) })
  }

  private func alert(_ title: String, _ message: String) {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard let scene = presenter?()?.view.window?.windowScene ?? scenes.first(where: { $0.activationState == .foregroundActive })
    else { return }
    let previous = scene.keyWindow
    let window = UIWindow(windowScene: scene)
    window.windowLevel = .alert
    window.backgroundColor = .clear
    window.rootViewController = UIViewController()
    window.rootViewController?.view.backgroundColor = .clear
    alertWindows.append(window)
    let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default) { [weak self, weak window, weak previous] _ in
      window?.isHidden = true
      self?.alertWindows.removeAll { $0 === window }
      previous?.makeKey()
    })
    window.makeKeyAndVisible()
    window.rootViewController?.present(alert, animated: true)
  }
}
