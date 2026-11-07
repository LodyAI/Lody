import Foundation

@MainActor
final class OutboxFixture {
  static let user = "ui-outbox-preview"
  static let workspace = "fixture"

  private let store: OutboxStore
  private let alert: (String, String) -> Void
  private let notify: () -> Void
  private var calls = 0
  private var reserves = Set<String>()
  private var failNext = false
  private var quotaNext = false
  private var requests: [CheckedContinuation<String, Error>] = []
  private lazy var dispatcher = OutboxDispatcher(services: services, inflight: OutboxInflight()) { String(localized: String.LocalizationValue($0), bundle: .lody) }

  init(store: OutboxStore, alert: @escaping (String, String) -> Void, notify: @escaping () -> Void) {
    self.store = store
    self.alert = alert
    self.notify = notify
    dispatcher.update(store: store, inputs: .init(userId: Self.user, connected: true))
  }

  var state: String { #"{"calls":\#(calls),"reserves":\#(reserves.count)}"# }

  func changed(_ store: OutboxStore) {
    if store === self.store { dispatcher.schedule() }
  }

  func perform(_ action: String) {
    switch action {
    case "failNext": failNext = true
    case "quotaNext": quotaNext = true
    case "confirm": confirm(all: false)
    case "confirmAll": confirm(all: true)
    default: break
    }
  }

  func stop() {
    requests.forEach { $0.resume(throwing: CancellationError()) }
    requests = []
  }

  private func confirm(all: Bool) {
    let confirmed = all ? requests : Array(requests.prefix(1))
    requests.removeFirst(confirmed.count)
    confirmed.forEach { $0.resume(returning: #"{"state":"accepted"}"#) }
  }

  private var services: OutboxServices {
    OutboxServices(
      createSession: { [weak self] payload in
        if self?.quotaNext == true {
          self?.quotaNext = false
          return #"{"state":"rejected","reason":"free_session_limit_reached"}"#
        }
        return #"{"state":"created","session":"# + payload + "}"
      },
      ensureSession: { [weak self] id in
        guard let self else { throw CancellationError() }
        self.reserves.insert(id)
        self.notify()
        if self.failNext {
          self.failNext = false
          throw CancellationError()
        }
      },
      sendSessionTurn: { [weak self] _ in
        guard let self else { throw CancellationError() }
        self.calls += 1
        self.notify()
        return try await withCheckedThrowingContinuation { self.requests.append($0) }
      },
      releaseReserve: { [weak self] id in
        self?.reserves.remove(id)
        self?.notify()
      },
      alert: { [weak self] in self?.alert($0, $1) })
  }
}
