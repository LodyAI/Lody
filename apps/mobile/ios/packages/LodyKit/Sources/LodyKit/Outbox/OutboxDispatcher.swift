import Foundation

struct OutboxServices {
  var createSession: @MainActor (String) async throws -> String
  var ensureSession: @MainActor (String) async throws -> Void
  var sendSessionTurn: @MainActor (String) async throws -> String
  var releaseReserve: @MainActor (String) -> Void
  var alert: @MainActor (_ title: String, _ message: String) -> Void
}

final class OutboxInflight: @unchecked Sendable {
  private let lock = NSLock()
  private var ids = Set<String>()

  func contains(_ id: String) -> Bool { lock.withLock { ids.contains(id) } }
  func set(_ id: String, _ active: Bool) {
    lock.withLock {
      if active { ids.insert(id) } else { ids.remove(id) }
    }
  }
}

@MainActor
final class OutboxDispatcher {
  struct Inputs: Equatable {
    var userId = ""
    var connected = false
    var foregroundSessionId = ""
    var latestUserMessages: [String: String] = [:]
    var catalogRevision = 0
    var context = OutboxForeground()
  }

  private typealias Plan = (queue: Bool, guide: Bool)

  private struct Trigger: Equatable {
    let store: ObjectIdentifier?
    let revision: Int
    let inputs: Inputs
  }

  static let maxSessionReserves = 8
  private static let occupying: Set<String> = ["creating", "sending", "unknown", "uploaded"]
  private static let settled: Set<String> = ["accepted", "queued", "failed"]
  static let busy: Set<String> = ["running", "initializing", "processing", "in_progress", "queued", "requestPermission", "waiting"]

  let inflight: OutboxInflight
  var settled: (() -> Void)?
  private let services: OutboxServices
  private let text: (String) -> String
  private let foreground: String?
  private var store: OutboxStore?
  private var inputs = Inputs()
  private var released: [String: String] = [:]
  private var trigger: Trigger?
  private var scheduled = false
  private var observer: NSObjectProtocol?
  private var holding = Set<String>()

  init(services: OutboxServices, inflight: OutboxInflight, foreground: String? = nil, text: @escaping (String) -> String) {
    self.services = services
    self.inflight = inflight
    self.foreground = foreground
    self.text = text
    // The page and background dispatchers share one inflight set. A dispatcher that saw a session
    // held by the other one recorded its trigger and returned; nothing else wakes it once the hold
    // ends, so a settled record (unknown, accepted, waiting) would keep its stale status.
    observer = NotificationCenter.default.addObserver(forName: .lodyOutboxInflightReleased, object: inflight, queue: nil) {
      [weak self] note in
      let releaser = note.userInfo?["dispatcher"] as? ObjectIdentifier
      MainActor.assumeIsolated {
        guard let self, releaser != ObjectIdentifier(self) else { return }
        self.trigger = nil
        self.schedule()
        // The page's composer reads the shared set for canSend; refresh it even if no record changes.
        self.settled?()
      }
    }
  }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  func update(store: OutboxStore?, inputs: Inputs) {
    self.store = store
    self.inputs = inputs
    schedule()
  }

  func schedule() {
    guard !scheduled else { return }
    scheduled = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      self.scheduled = false
      self.run()
    }
  }

  private func run() {
    let next = Trigger(store: store.map(ObjectIdentifier.init), revision: store?.revision ?? 0, inputs: inputs)
    guard next != trigger else { return }
    trigger = next
    guard let store, store.snapshot.ready else { return }
    let records = store.snapshot.records
    if let foreground {
      if let record = records.first(where: { $0.sessionId == foreground }) { considerForeground(record, store: store) }
      return
    }
    guard !inputs.userId.isEmpty else { return }
    var slots = records.filter { $0.sessionId != inputs.foregroundSessionId && Self.occupying.contains($0.phase) }.count
    for record in records { consider(record, store: store, slots: &slots) }
  }

  private func consider(_ record: OutboxRecord, store: OutboxStore, slots: inout Int) {
    let id = record.sessionId, phase = record.phase
    if Self.settled.contains(phase) {
      let key = "\(id):\(record.sendId):\(phase)"
      guard released[id] != key else { return }
      released[id] = key
      services.releaseReserve(id)
      return
    }
    released[id] = nil
    let latest = inputs.latestUserMessages[id]
    if phase == "unknown" || phase == "uploaded", latest == record.sendId {
      let removal = store.remove(id)
      let services = services
      Task { @MainActor in
        _ = await removal.result
        services.releaseReserve(id)
      }
      return
    }
    if record.creation != nil, latest != nil, phase == "unknown" {
      store.put(record.with(phase: "waiting", dropCreation: true))
      return
    }
    guard id != inputs.foregroundSessionId, phase == "waiting", !inflight.contains(id),
          inputs.connected, slots < Self.maxSessionReserves else { return }
    slots += 1
    start(record, store: store, plan: nil)
  }

  private func considerForeground(_ record: OutboxRecord, store: OutboxStore) {
    let id = record.sessionId, phase = record.phase, context = inputs.context
    guard !inflight.contains(id) else { return }
    if record.creation == nil, context.transcript.replied.contains(record.sendId) {
      store.remove(id)
      return
    }
    if record.creation != nil, context.serverCreated, phase == "unknown" {
      store.put(record.with(phase: "waiting", dropCreation: true))
      return
    }
    guard phase == "waiting", !context.overflow, !inputs.userId.isEmpty,
          record.creation != nil || !context.transcript.entryIds.contains(record.sendId),
          record.creation == nil ? context.live : inputs.connected else { return }
    start(record, store: store, plan: context.plan(record.send))
  }

  private func start(_ record: OutboxRecord, store: OutboxStore, plan: Plan?) {
    let id = record.sessionId
    inflight.set(id, true)
    holding.insert(id)
    let marked = record.with(phase: record.creation == nil ? "sending" : "creating")
    let marking = store.put(marked)
    let userId = inputs.userId
    Task { @MainActor in
      await self.dispatch(record, marked: marked, marking: marking, store: store, userId: userId, plan: plan)
      self.release(id)
      guard self.foreground != nil else { return }
      self.trigger = nil
      self.schedule()
      self.settled?()
    }
  }

  private func release(_ id: String) {
    // A created session is released before its write settles; the page may claim it meanwhile.
    guard holding.remove(id) != nil else { return }
    inflight.set(id, false)
    // Wake only the other dispatchers: rerunning this one would retry a session_not_ready
    // background send at once instead of on the next catalog change.
    NotificationCenter.default.post(name: .lodyOutboxInflightReleased, object: inflight,
                                    userInfo: ["dispatcher": ObjectIdentifier(self)])
  }

  private func dispatch(_ record: OutboxRecord, marked: OutboxRecord, marking: Task<Void, Error>,
                        store: OutboxStore, userId: String, plan: Plan?) async {
    let id = record.sessionId
    var started = false
    do {
      try await marking.value
      let latest = store.snapshot.records.first { $0.sessionId == id }
      guard latest?.sendId == record.sendId, latest?.phase == marked.phase else { return }
      if let creation = record.creation {
        started = true
        let result = try Self.parse(await services.createSession(creation))
        switch result["state"]?.string {
        case "created":
          guard let session = result["session"]?.object else { throw OutboxError.invalidRecord }
          release(id)
          var created = record.with(phase: "waiting", dropCreation: true)
          created.session = session
          try await store.put(created).value
        case "rejected":
          await fail(record, store: store, reason: quotaError(result["reason"]?.string, fallback: "send.error.sessionNotCreated"))
        default:
          try await store.put(record.with(phase: "unknown")).value
        }
        return
      }
      do { try await services.ensureSession(id) } catch {
        await fail(record, store: store, reason: text("native.runtime.sessionNotSyncedRetry"))
        return
      }
      started = true
      let result = try Self.parse(await services.sendSessionTurn(Self.turn(record, userId: userId, plan: plan)))
      let state = result["state"]?.string ?? ""
      if state == "not_sent" {
        if plan == nil, result["reason"]?.string == "session_not_ready" {
          try await store.put(record.with(phase: "waiting")).value
          return
        }
        await fail(record, store: store, reason: quotaError(result["reason"]?.string, fallback: "send.error.notSent"))
        return
      }
      var next = record.with(phase: ["accepted", "uploaded", "queued"].contains(state) ? state : "unknown")
      if let plan { next.send["guide"] = .bool(plan.guide) }
      try await store.put(next).value
    } catch {
      if started { _ = await store.put(record.with(phase: "unknown")).result }
      else { await fail(record, store: store, reason: text("send.error.draftSaveFailed")) }
    }
  }

  private func fail(_ record: OutboxRecord, store: OutboxStore, reason: String) async {
    let reason = reason == "mention_expansion_failed" ? text("send.error.mentions") : reason
    _ = await store.put(record.with(phase: "failed", reason: reason)).result
    services.alert(text("send.alert.title"), reason)
  }

  func quotaError(_ reason: String?, fallback: String) -> String {
    let keys = [
      "shortcut_unavailable": "send.error.shortcut",
      "mcp_catalog_unavailable": "send.error.mcpCatalog",
      "mcp_connection_missing": "send.error.mcpConnection",
      "workspace_payment_required": "send.error.workspacePaymentRequired",
      "free_session_limit_reached": "send.error.freeSessionLimit",
      "free_session_turn_limit_reached": "send.error.freeTurnLimit",
    ]
    if let reason, let key = keys[reason] { return text(key) }
    if let reason, !reason.isEmpty { return reason }
    return text(fallback)
  }

  private static func parse(_ json: String) throws -> [String: OutboxValue] {
    guard let value = try JSONDecoder().decode(OutboxValue.self, from: Data(json.utf8)).object else {
      throw OutboxError.invalidRecord
    }
    return value
  }

  static func turn(_ record: OutboxRecord, userId: String, plan: (queue: Bool, guide: Bool)? = nil) -> String {
    let session = record.session, send = record.send
    let busy = send["queue"] == .bool(true) || Self.busy.contains(session["status"]?.string ?? "")
    let plan = plan ?? (send["guide"]?.truthy != true && busy, send["guide"] == .bool(true))
    var payload: [String: OutboxValue] = [
      "userId": .string(userId),
      "guide": .bool(plan.guide),
      "queue": .bool(plan.queue),
    ]
    payload["sessionId"] = session["id"]
    for key in ["machineId", "cliType", "agentType", "resume"] { payload[key] = session[key] }
    for key in ["id", "text", "attachments", "agentRoleId"] { payload[key] = send[key] }
    let choice = send["choice"]?.object ?? [:]
    for (from, to) in [("modelId", "modelId"), ("modeId", "modeId"), ("effort", "reasoningEffort"),
                       ("reasoningEffortConfigId", "reasoningEffortConfigId"), ("configOptionValues", "configOptionValues")] {
      payload[to] = choice[from]
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    return (try? encoder.encode(OutboxValue.object(payload))).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }
}
