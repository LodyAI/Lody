import Foundation

@MainActor
final class SessionSender {
  struct Inputs: Equatable {
    var userId = ""
    var connected = false
    var session: SessionItem?
    var context = OutboxForeground()
  }

  let sessionId: String
  var changed: (() -> Void)?
  var clearDraft: ((Int) -> Void)?
  var restoreDraft: ((Int) -> Void)?
  private let store: OutboxStore?
  private let dispatcher: OutboxDispatcher
  private let inflight: OutboxInflight
  private(set) var inputs = Inputs()
  private var observers: [NSObjectProtocol] = []
  private var clearToken = 0
  private var restoreToken = 0
  private var cleared = ""
  private var previous: OutboxRecord?
  private var progress: [String: OutboxValue] = [:]
  private var progressKey = ""

  init(sessionId: String, store: OutboxStore?, services: OutboxServices, inflight: OutboxInflight) {
    self.sessionId = sessionId
    self.store = store
    self.inflight = inflight
    dispatcher = OutboxDispatcher(services: services, inflight: inflight, foreground: sessionId) { String(localized: String.LocalizationValue($0), bundle: .lody) }
    previous = record
    dispatcher.settled = { [weak self] in self?.changed?() }
    observers = [
      NotificationCenter.default.addObserver(forName: .lodyOutboxDidChange, object: store, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.storeChanged() }
      },
      NotificationCenter.default.addObserver(forName: .lodyAttachmentUploadProgress, object: nil, queue: .main) { [weak self] note in
        let event = SessionUploadProgress(note.userInfo ?? [:])
        MainActor.assumeIsolated { self?.received(event) }
      },
    ]
  }

  isolated deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    dispatcher.update(store: nil, inputs: .init())
  }

  var record: OutboxRecord? { store?.snapshot.records.first { $0.sessionId == sessionId } }
  var ready: Bool { store?.snapshot.ready == true }
  private var dispatching: Bool { inflight.contains(sessionId) }

  var sending: Bool {
    guard let record else { return false }
    let guideUploaded = record.send["guide"]?.truthy == true && record.phase == "uploaded"
    return !["failed", "accepted", "queued"].contains(record.phase) && !guideUploaded
  }

  var awaitingReply: Bool {
    guard let record, record.creation == nil else { return false }
    return ["accepted", "uploaded"].contains(record.phase)
  }

  var canSend: Bool {
    ready && !dispatching && !sending && !inputs.context.overflow
      && inputs.session?.archived != true && !inputs.userId.isEmpty
  }

  var pendingSendJSON: String {
    guard let record else { return "" }
    let phase = record.phase, live = inputs.context.live
    var send = record.send
    if phase == "sending" { send["uploadProgress"] = .object(progress) }
    let queued = phase == "queued" || !["accepted", "uploaded", "failed"].contains(phase)
    send["queue"] = .bool(record.send["queue"] == .bool(true) && queued)
    send["status"] = .string(String(localized: String.LocalizationValue(OutboxForeground.statusKey(record.send, live: live)), bundle: .lody))
    send["reconnect"] = .bool(phase == "waiting" && !live)
    send["failed"] = .bool(phase == "failed")
    return Self.encode(.object(send))
  }

  func update(_ next: Inputs) {
    inputs = next
    dispatcher.update(store: store, inputs: .init(userId: next.userId, connected: next.connected, context: next.context))
    settle()
  }

  func submit(_ event: [String: Any], choice: [String: OutboxValue], role: OutboxValue? = nil) {
    let current = record
    guard let store, ready, !dispatching, !sending, !inputs.context.overflow, inputs.session?.archived != true,
          !inputs.userId.isEmpty, let session = inputs.session?.outboxValue ?? current?.session,
          var send = Self.object(event) else {
      restoreToken += 1
      restoreDraft?(restoreToken)
      return
    }
    var choice = choice
    if choice["configOptionValues"] == nil || choice["configOptionValues"] == .null {
      choice["configOptionValues"] = current?.send["choice"]?.object?["configOptionValues"]
    }
    send["choice"] = .object(choice)
    // The turn's Agent Role (web session composer); absent inherits the latest turn's.
    send["agentRoleId"] = role
    send["guide"] = .bool(send["guide"] == .bool(true) && inputs.context.steerable)
    send["creation"] = current?.send["creation"]
    send["phase"] = .string("waiting")
    let draft = OutboxRecord(session: session, send: send)
    let put = store.put(draft)
    Task { @MainActor in
      guard case .failure = await put.result else { return }
      store.put(draft.with(phase: "failed", reason: String(localized: "send.error.draftSaveShort", bundle: .lody)))
    }
  }

  func discardPending(_ inputId: String) async throws {
    guard let store, let record, record.sendId == inputId else { return }
    guard ["unknown", "uploaded"].contains(record.phase), !dispatching else { throw OutboxError.scopeExpired }
    try await store.remove(sessionId).value
  }

  func retry() {
    guard let store, let record, record.phase == "failed", !dispatching else { return }
    var next = record.with(phase: "waiting")
    next.send["reason"] = nil
    store.put(next)
  }

  private func storeChanged() {
    dispatcher.schedule()
    settle()
  }

  private func settle() {
    let record = record
    let key = record.map { "\($0.sendId):\($0.phase)" } ?? ""
    if key != progressKey {
      progressKey = key
      progress = [:]
    }
    if let previous, previous.creation == nil, record?.sendId != previous.sendId,
       inputs.context.transcript.replied.contains(previous.sendId) {
      clear(previous)
    }
    if let record {
      let uploaded = record.phase == "uploaded" && previous?.sendId == record.sendId && previous?.phase == "sending"
      if ["accepted", "queued"].contains(record.phase) || uploaded { clear(record) }
    }
    previous = record
    changed?()
  }

  private func clear(_ record: OutboxRecord) {
    guard record.send["preserveDraft"]?.truthy != true, cleared != record.sendId else { return }
    cleared = record.sendId
    clearToken += 1
    clearDraft?(clearToken)
  }

  private func received(_ event: SessionUploadProgress) {
    guard let record, record.phase == "sending", event.sessionId == sessionId, event.sendId == record.sendId,
          case .array(let attachments)? = record.send["attachments"],
          attachments.contains(where: { $0.object?["id"]?.string == event.attachmentId }) else { return }
    var value: [String: OutboxValue] = ["phase": .string(event.phase)]
    if let percent = event.percent { value["percent"] = .number(Double(percent)) }
    guard progress[event.attachmentId] != .object(value) else { return }
    progress[event.attachmentId] = .object(value)
    changed?()
  }

  static func object(_ value: [String: Any]) -> [String: OutboxValue]? {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
    return (try? JSONDecoder().decode(OutboxValue.self, from: data))?.object
  }

  static func encode(_ value: OutboxValue) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }
}

struct SessionUploadProgress: Sendable {
  var sessionId = ""
  var sendId = ""
  var attachmentId = ""
  var phase = ""
  var percent: Int?

  init(_ info: [AnyHashable: Any]) {
    sessionId = info["sessionId"] as? String ?? ""
    sendId = info["sendId"] as? String ?? ""
    attachmentId = info["attachmentId"] as? String ?? ""
    phase = info["phase"] as? String ?? ""
    percent = (info["percent"] as? NSNumber)?.intValue
  }
}

extension SessionItem {
  var outboxValue: [String: OutboxValue] {
    var value: [String: OutboxValue] = [
      "id": .string(id), "machineId": .string(machineId), "title": .string(title), "status": .string(status),
      "archived": .bool(archived), "pinned": .bool(pinned), "projectId": .string(projectId), "createdAt": .string(createdAt),
    ]
    for (key, text) in [("cliType", cliType), ("agentType", agentType), ("resume", resume ?? ""), ("branchName", branchName ?? "")]
    where !text.isEmpty {
      value[key] = .string(text)
    }
    if let lastMessageAt { value["lastMessageAt"] = .number(lastMessageAt) }
    return value
  }
}

extension Notification.Name {
  static let lodyOutboxDidChange = Notification.Name("LodyOutboxDidChange")
  static let lodyAttachmentUploadProgress = Notification.Name("LodyAttachmentUploadProgress")
}
