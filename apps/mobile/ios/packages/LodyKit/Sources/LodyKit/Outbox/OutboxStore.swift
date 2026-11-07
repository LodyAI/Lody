import Foundation

struct OutboxPersistence: Sendable {
  var generation: @Sendable () -> Int
  var read: @Sendable (String) async -> String?
  var write: @Sendable (_ key: String, _ value: String, _ generation: Int) async throws -> Void
}

enum OutboxError: Error, Equatable {
  case scopeExpired
  case invalidRecord
}

@MainActor
final class OutboxStore {
  struct Snapshot: Equatable {
    var records: [OutboxRecord] = []
    var ready = false
  }

  let key: String
  let generation: Int
  private(set) var snapshot = Snapshot()
  private(set) var revision = 0
  var onChange: (() -> Void)?
  private let persistence: OutboxPersistence
  private var durable: [OutboxRecord] = []
  private var touched = Set<String>()
  private var writes: Task<Void, Never>

  init(key: String, generation: Int, persistence: OutboxPersistence, awaitingConfirmation: String) {
    self.key = key
    self.generation = generation
    self.persistence = persistence
    writes = Task {}
    writes = Task { @MainActor [weak self] in
      let saved = await persistence.read(key)
      guard let self, generation == persistence.generation() else { return }
      self.durable = OutboxRecord.restore(saved, awaitingConfirmation: awaitingConfirmation)
      let restored = self.durable.filter { !self.touched.contains($0.sessionId) }
      self.publish(restored + self.snapshot.records, ready: true)
    }
  }

  var json: String {
    let records = OutboxRecord.encode(snapshot.records)
    return #"{"ready":\#(snapshot.ready),"records":\#(records)}"#
  }

  @discardableResult
  func put(_ record: OutboxRecord) -> Task<Void, Error> {
    change(record.sessionId, record)
  }

  @discardableResult
  func remove(_ sessionId: String) -> Task<Void, Error> {
    change(sessionId, nil)
  }

  private var current: Bool { generation == persistence.generation() }

  private func change(_ sessionId: String, _ record: OutboxRecord?) -> Task<Void, Error> {
    guard current else { return Task { throw OutboxError.scopeExpired } }
    touched.insert(sessionId)
    publish(Self.replace(snapshot.records, sessionId, record), ready: snapshot.ready)
    let previous = writes, key = key, generation = generation, persistence = persistence
    let write = Task { @MainActor [weak self] in
      await previous.value
      guard let self, self.current else { throw OutboxError.scopeExpired }
      let next = Self.replace(self.durable, sessionId, record)
      try await persistence.write(key, OutboxRecord.encode(next), generation)
      guard self.current else { throw OutboxError.scopeExpired }
      self.durable = next
    }
    writes = Task { _ = await write.result }
    return write
  }

  private static func replace(_ records: [OutboxRecord], _ sessionId: String, _ record: OutboxRecord?) -> [OutboxRecord] {
    var next = records.filter { $0.sessionId != sessionId }
    if let record { next.append(record) }
    return next
  }

  private func publish(_ records: [OutboxRecord], ready: Bool) {
    snapshot = Snapshot(records: records, ready: ready)
    revision += 1
    onChange?()
  }
}

@MainActor
final class OutboxStores {
  private let persistence: OutboxPersistence
  private let awaitingConfirmation: () -> String
  private var stores: [String: OutboxStore] = [:]
  private var generation: Int
  var onChange: ((OutboxStore) -> Void)?
  var onReset: (() -> Void)?

  init(persistence: OutboxPersistence, awaitingConfirmation: @escaping () -> String) {
    self.persistence = persistence
    self.awaitingConfirmation = awaitingConfirmation
    generation = persistence.generation()
  }

  nonisolated static func key(user: String, workspace: String) -> String {
    user.isEmpty || workspace.isEmpty ? "" : "pending-sends:\(user):\(workspace)"
  }

  func store(user: String, workspace: String) -> OutboxStore? {
    let current = persistence.generation()
    if generation != current {
      stores.removeAll()
      generation = current
      onReset?()
    }
    let key = Self.key(user: user, workspace: workspace)
    guard !key.isEmpty else { return nil }
    if let store = stores[key] { return store }
    let store = OutboxStore(key: key, generation: current, persistence: persistence, awaitingConfirmation: awaitingConfirmation())
    store.onChange = { [weak self, unowned store] in self?.onChange?(store) }
    stores[key] = store
    return store
  }
}
