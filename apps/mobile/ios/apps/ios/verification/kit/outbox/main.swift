import Foundation
import LodyCore

@MainActor final class Gate {
  private var waiters: [CheckedContinuation<Void, Error>] = []
  private var outcome: Result<Void, Error>?

  func wait() async throws {
    if let outcome { return try outcome.get() }
    try await withCheckedThrowingContinuation { waiters.append($0) }
  }

  func open(_ result: Result<Void, Error> = .success(())) {
    outcome = result
    waiters.forEach { $0.resume(with: result) }
    waiters = []
  }
}

@MainActor final class Disk {
  var generation = 0
  var values: [String: String] = [:]
  var writes: [(key: String, value: String)] = []
  var hydration: [String: Gate] = [:]
  var block: Gate?

  var persistence: OutboxPersistence {
    OutboxPersistence(
      generation: { MainActor.assumeIsolated { self.generation } },
      read: { key in await self.read(key) },
      write: { key, value, generation in try await self.write(key, value, generation) })
  }

  func read(_ key: String) async -> String? {
    if let gate = hydration[key] { try? await gate.wait() }
    return values[key]
  }

  func write(_ key: String, _ value: String, _ version: Int) async throws {
    writes.append((key, value))
    if let block { try await block.wait() }
    if version == generation { values[key] = value }
  }

  func records(_ key: String) -> [OutboxRecord] {
    values[key].flatMap { try? JSONDecoder().decode([OutboxRecord].self, from: Data($0.utf8)) } ?? []
  }
}

@MainActor final class Network {
  var ensured: [String] = []
  var sent: [[String: OutboxValue]] = []
  var created: [String] = []
  var released: [String] = []
  var alerts: [(String, String)] = []
  var ensure: (String) async throws -> Void = { _ in }
  var send: ([String: OutboxValue]) async throws -> String = { _ in #"{"state":"accepted"}"# }
  var create: (String) async throws -> String = { _ in throw OutboxError.invalidRecord }

  var services: OutboxServices {
    OutboxServices(
      createSession: { payload in self.created.append(payload); return try await self.create(payload) },
      ensureSession: { id in self.ensured.append(id); try await self.ensure(id) },
      sendSessionTurn: { payload in
        let args = try JSONDecoder().decode(OutboxValue.self, from: Data(payload.utf8)).object ?? [:]
        self.sent.append(args)
        return try await self.send(args)
      },
      releaseReserve: { self.released.append($0) },
      alert: { self.alerts.append(($0, $1)) })
  }
}

func settle() async {
  for _ in 0..<6 {
    try? await Task.sleep(nanoseconds: 2_000_000)
    await Task.yield()
  }
}

func session(_ id: String, status: String = "idle") -> [String: OutboxValue] {
  ["id": .string(id), "machineId": .string("m1"), "cliType": .string("builtin"), "agentType": .string("codex"),
   "archived": .bool(false), "status": .string(status)]
}

func record(_ id: String, phase: String = "waiting", sendId: String? = nil, extra: [String: OutboxValue] = [:]) -> OutboxRecord {
  var send: [String: OutboxValue] = [
    "id": .string(sendId ?? "turn-\(id)"), "text": .string("hello"), "startedAt": .number(1_780_000_000_000),
    "attachments": .array([.object(["id": .string("file"), "uri": .string("file:///draft"), "name": .string("draft.txt"), "kind": .string("file")])]),
    "phase": .string(phase), "choice": .object([:]),
  ]
  send.merge(extra) { $1 }
  return OutboxRecord(session: session(id), send: send)
}

@MainActor func phases(_ store: OutboxStore) -> [String] { store.snapshot.records.map(\.phase) }

@MainActor var retained: [AnyObject] = []

@MainActor func harness(_ records: [OutboxRecord], _ network: Network, inputs: OutboxDispatcher.Inputs? = nil,
                        foreground: String? = nil) async -> (OutboxDispatcher, OutboxStore, Disk) {
  let disk = Disk()
  disk.values["pending-sends:u1:w"] = OutboxRecord.encode(records)
  let stores = OutboxStores(persistence: disk.persistence, awaitingConfirmation: { "send.reason.awaitingConfirmation" })
  retained.append(stores)
  let store = stores.store(user: "u1", workspace: "w")!
  let dispatcher = OutboxDispatcher(services: network.services, inflight: OutboxInflight(), foreground: foreground, text: { $0 })
  stores.onChange = { [weak dispatcher] _ in dispatcher?.schedule() }
  dispatcher.update(store: store, inputs: inputs ?? .init(userId: "u1", connected: true))
  await settle()
  return (dispatcher, store, disk)
}

@main struct OutboxCheck {
  @MainActor static func main() async throws {
    try await pendingSends()
    try await dispatch()
    try await foreground()
    try await handoff()
  }

  @MainActor static func pendingSends() async throws {
    let disk = Disk()
    let hydration = Gate()
    disk.hydration["pending-sends:u:w"] = hydration
    let invalid: OutboxValue = .array([
      .object(["session": .object(["id": .string("no-text")]), "send": .object(["id": .string("x"), "attachments": .array([]), "choice": .object([:])])]),
      .string("garbage"),
    ])
    let saved = [record("old", phase: "sending"), record("creating", phase: "creating"), record("failed", phase: "failed")]
    let invalidJSON = String(decoding: try JSONEncoder().encode(invalid), as: UTF8.self)
    let original = "[" + String(OutboxRecord.encode(saved).dropFirst().dropLast()) + "," + String(invalidJSON.dropFirst())
    disk.values["pending-sends:u:w"] = original
    let stores = OutboxStores(persistence: disk.persistence, awaitingConfirmation: { "send.reason.awaitingConfirmation" })
    let store = stores.store(user: "u", workspace: "w")!
    precondition(stores.store(user: "", workspace: "w") == nil, "an unscoped outbox has no durable store")
    var draft = record("new")
    disk.block = Gate()
    let put = store.put(draft)
    draft.send["text"] = .string("mutated outside store")
    precondition(store.snapshot.records.map(\.sessionId) == ["new"] && !store.snapshot.ready)
    precondition(store.snapshot.records[0].send["text"] == .string("hello"))
    await settle()
    precondition(disk.writes.isEmpty, "durable writes wait for hydration")
    hydration.open()
    await settle()
    precondition(store.snapshot.ready)
    precondition(phases(store) == ["unknown", "unknown", "failed", "waiting"], "\(phases(store))")
    precondition(store.snapshot.records[0].send["reason"] == .string("send.reason.awaitingConfirmation"))
    precondition(store.snapshot.records[2].send["reason"] == nil)
    precondition(disk.writes.count == 1 && !disk.writes[0].value.contains("mutated"))
    precondition(disk.values["pending-sends:u:w"] == original, "the merged write is not durable until it completes")
    disk.block?.open()
    disk.block = nil
    try await put.value
    let durable = disk.records("pending-sends:u:w")
    precondition(durable.count == 4 && durable.map(\.phase) == ["unknown", "unknown", "failed", "waiting"])
    precondition(durable[3].send["attachments"] == record("new").send["attachments"])
    print("PASS: pending sends publish before durable writes, merge hydration, and restore dispatch in flight as unknown")

    let writes = disk.writes.count
    disk.block = Gate()
    let first = store.put(record("new", phase: "sending"))
    let second = store.put(record("new", phase: "uploaded"))
    await settle()
    precondition(disk.writes.count == writes + 1, "a later write waits for the earlier one")
    disk.block?.open()
    disk.block = nil
    try await first.value
    try await second.value
    let last = disk.writes.suffix(2).map { write in
      (try? JSONDecoder().decode([OutboxRecord].self, from: Data(write.value.utf8)))?.last?.phase
    }
    precondition(last == ["sending", "uploaded"], "\(last)")
    precondition(stores.store(user: "other", workspace: "w") !== store && stores.store(user: "u", workspace: "w") === store)
    let failure = Gate()
    disk.block = failure
    let failedWrite = store.put(record("failed-write"))
    failure.open(.failure(OutboxError.invalidRecord))
    let failedResult = await failedWrite.result
    precondition(failedResult.isFailure)
    precondition(store.snapshot.records.contains { $0.sessionId == "failed-write" }, "a failed write keeps the published draft")
    disk.block = nil
    try await store.remove("failed-write").value
    precondition(!disk.records("pending-sends:u:w").contains { $0.sessionId == "failed-write" })
    disk.generation += 1
    let stale = await store.put(record("stale")).result
    precondition(stale.error == .scopeExpired && !store.snapshot.records.contains { $0.sessionId == "stale" })
    precondition(stores.store(user: "u", workspace: "w") !== store)
    print("PASS: pending sends serialize writes, isolate scopes, surface write failures and expire with the local generation")
  }

  @MainActor static func dispatch() async throws {
    var network = Network()
    var (dispatcher, store, disk) = await harness([record("s1", sendId: "D1")], network)
    precondition(network.ensured == ["s1"] && network.sent.count == 1 && network.sent[0]["id"] == .string("D1"))
    precondition(phases(store) == ["accepted"] && disk.records("pending-sends:u1:w").map(\.phase) == ["accepted"])
    precondition(network.sent[0]["queue"] == .bool(false) && network.sent[0]["machineId"] == .string("m1"))
    precondition(network.sent[0]["attachments"] == record("s1").send["attachments"])
    precondition(network.released == ["s1"], "an accepted send releases its reserve")
    print("PASS: a waiting send without a message page is ensured, then dispatched")

    network = Network()
    (dispatcher, store, _) = await harness([record("s1")], network, inputs: .init(userId: "u1", connected: true, foregroundSessionId: "s1"))
    precondition(network.ensured.isEmpty && phases(store) == ["waiting"])
    print("PASS: the foreground session is left to its page and does not consume a reserve slot")

    network = Network()
    (dispatcher, store, _) = await harness([record("s1", sendId: "D3")], network, inputs: .init(userId: "u1", connected: false))
    precondition(network.ensured.isEmpty && phases(store) == ["waiting"])
    dispatcher.update(store: store, inputs: .init(userId: "u1", connected: true))
    await settle()
    precondition(network.sent.count == 1 && phases(store) == ["accepted"])
    print("PASS: offline sends wait for a live connection, then dispatch")

    network = Network()
    (dispatcher, store, _) = await harness([record("s1", phase: "accepted", sendId: "D3")], network)
    precondition(network.released == ["s1"] && network.sent.isEmpty)
    dispatcher.schedule()
    await settle()
    precondition(network.released == ["s1"], "an unchanged accepted record releases once")
    try await store.put(record("s1", phase: "failed", sendId: "D3")).value
    await settle()
    precondition(network.released == ["s1", "s1"])
    try await store.put(record("s1", phase: "unknown", sendId: "D3")).value
    await settle()
    precondition(network.sent.isEmpty && phases(store) == ["unknown"], "unknown is never replayed")
    dispatcher.update(store: store, inputs: .init(userId: "u1", connected: true, latestUserMessages: ["s1": "D3"]))
    await settle()
    precondition(store.snapshot.records.isEmpty && network.released == ["s1", "s1", "s1"])
    print("PASS: accepted and failed records release reserves; unknown waits for catalog evidence")

    network = Network()
    let blocked = Gate()
    network.send = { _ in try await blocked.wait(); return #"{"state":"accepted"}"# }
    let nine = (0...OutboxDispatcher.maxSessionReserves).map { record("s\($0)", sendId: "0000000\($0)") }
    precondition(OutboxDispatcher.maxSessionReserves == 8)
    (dispatcher, store, _) = await harness(nine, network)
    precondition(network.ensured.count == 8 && !network.ensured.contains("s8"))
    precondition(store.snapshot.records.first { $0.sessionId == "s8" }?.phase == "waiting")
    blocked.open()
    await settle()
    precondition(network.ensured.contains("s8") && phases(store).allSatisfy { $0 == "accepted" })
    print("PASS: the ninth background waiting send is not ensured until a reserve frees")

    network = Network()
    network.create = { payload in #"{"state":"created","session":"# + payload + "}" }
    (dispatcher, store, _) = await harness([record("s1", extra: ["creation": .string(#"{"id":"s1","title":"created"}"#)])], network)
    precondition(network.created.count == 1 && network.ensured == ["s1"] && phases(store) == ["accepted"])
    precondition(store.snapshot.records[0].send["creation"] == nil && store.snapshot.records[0].session["title"] == .string("created"))
    print("PASS: create then first turn still run after the session page is gone")

    network = Network()
    network.create = { _ in #"{"state":"rejected","reason":"free_session_limit_reached"}"# }
    (dispatcher, store, _) = await harness([record("s1", extra: ["creation": .string("{}")])], network)
    precondition(phases(store) == ["failed"] && store.snapshot.records[0].send["reason"] == .string("send.error.freeSessionLimit"))
    precondition(store.snapshot.records[0].send["creation"] == .string("{}") && network.ensured.isEmpty)
    precondition(network.alerts.map(\.0) == ["send.alert.title"] && network.alerts[0].1 == "send.error.freeSessionLimit")
    network = Network()
    network.create = { _ in throw OutboxError.invalidRecord }
    (dispatcher, store, _) = await harness([record("s1", extra: ["creation": .string("{}")])], network)
    precondition(phases(store) == ["unknown"] && network.alerts.isEmpty, "an ambiguous creation is never retried")
    dispatcher.update(store: store, inputs: .init(userId: "u1", connected: true, latestUserMessages: ["s1": ""]))
    await settle()
    precondition(network.created.count == 1 && network.ensured == ["s1"] && phases(store) == ["accepted"])
    print("PASS: quota rejection keeps the draft with its alert; an unknown creation resumes only once the session exists")

    network = Network()
    let ack = Gate()
    network.send = { _ in try await ack.wait(); return #"{"state":"accepted"}"# }
    var owned: OutboxDispatcher?
    let dropped = await harness([record("s1")], network)
    owned = dropped.0
    store = dropped.1
    precondition(owned != nil && network.sent.count == 1)
    owned = nil
    ack.open()
    await settle()
    precondition(phases(store) == ["accepted"])
    print("PASS: dropping the dispatcher does not cancel an in-flight send")

    network = Network()
    var ready = false
    network.ensure = { _ in if !ready { throw OutboxError.scopeExpired } }
    (dispatcher, store, _) = await harness([record("s1")], network)
    precondition(network.sent.isEmpty && phases(store) == ["failed"] && store.snapshot.records[0].send["text"] == .string("hello"))
    precondition(store.snapshot.records[0].send["reason"] == .string("native.runtime.sessionNotSyncedRetry"))
    precondition(network.released == ["s1"] && network.alerts.count == 1)
    ready = true
    try await store.put(store.snapshot.records[0].with(phase: "waiting")).value
    await settle()
    precondition(network.sent.count == 1 && phases(store) == ["accepted"])
    print("PASS: a preparation failure retains a retryable draft without dispatching or occupying an unknown slot")

    network = Network()
    (dispatcher, store, _) = await harness([record("s1", extra: ["guide": .bool(true)])], network)
    precondition(network.sent.count == 1 && network.sent[0]["guide"] == .bool(true) && network.sent[0]["queue"] == .bool(false))
    network = Network()
    var busy = record("s2")
    busy.session["status"] = .string("running")
    (dispatcher, store, _) = await harness([busy], network)
    precondition(network.sent[0]["queue"] == .bool(true) && network.sent[0]["guide"] == .bool(false))
    print("PASS: a guide keeps its intent and busy sessions queue when the dispatcher takes over")

    network = Network()
    var replies = [#"{"state":"not_sent","reason":"session_not_ready"}"#, #"{"state":"not_sent","reason":"mention_expansion_failed"}"#]
    network.send = { _ in replies.removeFirst() }
    (dispatcher, store, _) = await harness([record("s1")], network)
    precondition(network.sent.count == 1 && phases(store) == ["waiting"] && network.alerts.isEmpty)
    dispatcher.update(store: store, inputs: .init(userId: "u1", connected: true, catalogRevision: 1))
    await settle()
    precondition(network.sent.count == 2 && phases(store) == ["failed"] && network.alerts.count == 1)
    precondition(store.snapshot.records[0].send["reason"] == .string("send.error.mentions"))
    network = Network()
    network.send = { _ in "not json" }
    (dispatcher, store, _) = await harness([record("s1")], network)
    precondition(phases(store) == ["unknown"] && network.alerts.isEmpty, "an unreadable ACK is ambiguous, not failed")
    print("PASS: session_not_ready waits again, definite rejections fail with an alert, ambiguous replies become unknown")
    _ = dispatcher
  }

  @MainActor static func page(_ entries: [[String: Any]] = [], live: Bool = true, running: Bool = false, steer: Bool = false,
                              behavior: String = "queue", serverCreated: Bool = false) -> OutboxDispatcher.Inputs {
    let context = OutboxForeground(
      live: live, serverCreated: serverCreated, steerable: steer, promptBusy: running, queuedMessageBehavior: behavior,
      transcript: SessionTranscriptFacts(entries: entries))
    return .init(userId: "u1", connected: true, context: context)
  }

  @MainActor static func foreground() async throws {
    var network = Network()
    let choice: OutboxValue = .object(["configOptionValues": .object(["permission_mode": .string("always-approve"), "fast": .bool(false)])])
    var (dispatcher, store, _) = await harness([record("s1", sendId: "F1", extra: ["choice": choice]), record("s2")], network,
                                               inputs: page(live: false), foreground: "s1")
    precondition(network.ensured.isEmpty && phases(store) == ["waiting", "waiting"])
    var settles = 0
    dispatcher.settled = { settles += 1 }
    dispatcher.update(store: store, inputs: page())
    await settle()
    precondition(settles == 1, "the page learns when its dispatch releases the session")
    precondition(network.ensured == ["s1"] && network.sent.count == 1 && network.sent[0]["id"] == .string("F1"))
    precondition(network.sent[0]["attachments"] == record("s1").send["attachments"] && network.sent[0]["queue"] == .bool(false))
    precondition(network.sent[0]["configOptionValues"] == choice.object?["configOptionValues"])
    precondition(phases(store).sorted() == ["accepted", "waiting"] && network.released.isEmpty, "the page leaves other sessions and reserves alone")
    print("PASS: the page dispatcher sends its own session once the transcript is live, with the same identity and choices")

    for state in ["not_sent", "unknown"] {
      network = Network()
      network.send = { _ in #"{"state":"\#(state)","reason":"session_not_ready"}"# }
      (dispatcher, store, _) = await harness([record("s1")], network, inputs: page(), foreground: "s1")
      precondition(phases(store) == [state == "not_sent" ? "failed" : "unknown"] && store.snapshot.records[0].send["text"] == .string("hello"))
      precondition(network.alerts.count == (state == "not_sent" ? 1 : 0))
      dispatcher.update(store: store, inputs: page([["id": "other", "role": "user"]]))
      await settle()
      precondition(network.sent.count == 1, "a definite or ambiguous result is never replayed automatically")
    }
    try await store.put(store.snapshot.records[0].with(phase: "failed")).value
    try await store.put(store.snapshot.records[0].with(phase: "waiting")).value
    await settle()
    precondition(network.sent.count == 2 && network.sent[1]["id"] == network.sent[0]["id"])
    print("PASS: page failures keep the draft, unknown results never replay, and an explicit retry reuses the identity")

    network = Network()
    network.create = { _ in #"{"state":"created","session":{"id":"s1","machineId":"m1"}}"# }
    (dispatcher, store, _) = await harness([record("s1", extra: ["creation": .string("{}")])], network,
                                           inputs: page(live: false), foreground: "s1")
    precondition(network.created.count == 1 && network.sent.isEmpty && phases(store) == ["waiting"])
    dispatcher.update(store: store, inputs: page())
    await settle()
    precondition(network.created.count == 1 && network.sent.count == 1 && phases(store) == ["accepted"])
    network = Network()
    (dispatcher, store, _) = await harness([record("s1", phase: "unknown", extra: ["creation": .string("{}")])], network,
                                           inputs: page(serverCreated: true), foreground: "s1")
    precondition(network.created.isEmpty && network.sent.count == 1 && phases(store) == ["accepted"])
    print("PASS: creation becomes one first turn after the destination is live; a server-created session resumes once")

    network = Network()
    (dispatcher, store, _) = await harness([record("s1", phase: "unknown", sendId: "D")], network,
                                           inputs: page([["id": "D", "role": "user"]]), foreground: "s1")
    precondition(phases(store) == ["unknown"])
    for entries: [[String: Any]] in [
      [["id": "D", "role": "user"], ["id": "x", "role": "assistant", "userTurnId": "other"]],
      [["id": "D", "role": "user"], ["id": "other", "role": "user"], ["id": "legacy", "role": "assistant"]],
    ] {
      dispatcher.update(store: store, inputs: page(entries))
      await settle()
      precondition(phases(store) == ["unknown"], "an unrelated reply cannot settle the send")
    }
    dispatcher.update(store: store, inputs: page([["id": "own", "role": "assistant", "userTurnId": "D"]]))
    await settle()
    precondition(store.snapshot.records.isEmpty && network.sent.isEmpty)
    network = Network()
    (dispatcher, store, _) = await harness([record("s1", sendId: "D")], network, inputs: page([["id": "D", "role": "user"]]), foreground: "s1")
    precondition(network.sent.isEmpty && phases(store) == ["waiting"], "a cached user row blocks a replay")
    print("PASS: only a causally matching reply settles a page send; a cached user row never confirms or replays it")

    let running: [[String: Any]] = [["id": "active", "role": "assistant", "finished": false]]
    for (steer, behavior, queue, guide) in [(true, "guide", false, true), (true, "queue", true, false), (false, "guide", true, false)] {
      network = Network()
      (dispatcher, store, _) = await harness([record("s1")], network,
                                             inputs: page(running, running: true, steer: steer, behavior: behavior), foreground: "s1")
      precondition(network.sent[0]["queue"] == .bool(queue) && network.sent[0]["guide"] == .bool(guide), "\(steer) \(behavior)")
      precondition(store.snapshot.records[0].send["guide"] == .bool(guide))
    }
    network = Network()
    (dispatcher, store, _) = await harness([record("s1", extra: ["guide": .bool(true)])], network, inputs: page(), foreground: "s1")
    precondition(network.sent[0]["guide"] == .bool(false) && network.sent[0]["queue"] == .bool(false), "guide needs steer capability")
    print("PASS: page routing guides only with steer capability and the guide preference, and queues behind a running reply")
    _ = dispatcher
  }

  @MainActor static func handoff() async throws {
    for creation in [false, true] {
      let network = Network()
      let ack = Gate()
      network.send = { _ in try await ack.wait(); return #"{"state":"accepted"}"# }
      network.create = { _ in try await ack.wait(); return #"{"state":"created","session":{"id":"s1","machineId":"m1"}}"# }
      let disk = Disk()
      let extra: [String: OutboxValue] = creation ? ["creation": .string("{}")] : [:]
      disk.values["pending-sends:u1:w"] = OutboxRecord.encode([record("s1", sendId: "H", extra: extra)])
      let stores = OutboxStores(persistence: disk.persistence, awaitingConfirmation: { "send.reason.awaitingConfirmation" })
      let store = stores.store(user: "u1", workspace: "w")!
      let inflight = OutboxInflight()
      let global = OutboxDispatcher(services: network.services, inflight: inflight, text: { $0 })
      var owned: OutboxDispatcher? = OutboxDispatcher(services: network.services, inflight: inflight, foreground: "s1", text: { $0 })
      stores.onChange = { [weak global, weak owned] _ in global?.schedule(); owned?.schedule() }
      global.update(store: store, inputs: .init(userId: "u1", connected: true, foregroundSessionId: "s1"))
      owned?.update(store: store, inputs: page(live: true))
      await settle()
      precondition(network.sent.count + network.created.count == 1, "the page dispatches its session once")
      global.update(store: store, inputs: .init(userId: "u1", connected: true, latestUserMessages: creation ? [:] : ["s1": ""]))
      owned?.update(store: nil, inputs: .init())
      owned = nil
      await settle()
      precondition(network.sent.count + network.created.count == 1, "leaving the page mid-send never redispatches the same id")
      ack.open()
      await settle()
      let ids = network.sent.compactMap { $0["id"]?.string }
      precondition(ids == ["H"] && network.created.count == (creation ? 1 : 0) && phases(store) == ["accepted"], "\(ids) \(phases(store))")
    }
    let network = Network()
    let ack = Gate()
    network.send = { _ in try await ack.wait(); return #"{"state":"accepted"}"# }
    let (global, store, _) = await harness([record("s1", sendId: "B")], network)
    let owned = OutboxDispatcher(services: network.services, inflight: global.inflight, foreground: "s1", text: { $0 })
    global.update(store: store, inputs: .init(userId: "u1", connected: true, foregroundSessionId: "s1"))
    owned.update(store: store, inputs: page(live: true))
    await settle()
    ack.open()
    await settle()
    precondition(network.sent.count == 1 && phases(store) == ["accepted"], "a page opened mid-send leaves the background write alone")
    print("PASS: the page and background dispatchers hand a session over without dispatching the same id twice")
  }
}

extension Result {
  var isFailure: Bool {
    if case .failure = self { return true }
    return false
  }

}

extension Result where Failure == Error {
  var error: OutboxError? {
    if case .failure(let error) = self { return error as? OutboxError }
    return nil
  }
}
