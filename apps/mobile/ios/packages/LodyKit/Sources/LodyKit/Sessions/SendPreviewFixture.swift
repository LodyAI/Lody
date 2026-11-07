import LodyCore
import UIKit

@MainActor
final class SendPreviewFixture {
  struct Options {
    var queue = false
    var steer = true
    var behavior = "queue"
    var longContext = false
  }

  static let sessionId = "offline-send-preview"
  static let user = "ui-send-preview"
  static let workspace = "fixture"
  let options: Options
  let store: OutboxStore?
  var changed: (() -> Void)?
  weak var presenter: UIViewController?
  private(set) var calls = 0
  private(set) var controlRequest = ""
  private(set) var connected = false
  var contextChip = false
  private var status = "offline"
  private var revision = 0
  private(set) var entries: [[String: Any]]
  private var receive: (@MainActor (SessionRuntimeEvent) -> Void)?
  private var completion: CheckedContinuation<String, Error>?
  private var submitted: (id: String, guide: Bool)?
  private var guideReceipts: [String] = []
  private var control: (action: String, messageId: String?, resume: CheckedContinuation<String, Error>?)?
  private var uploadStep = 0

  init(options: Options) {
    self.options = options
    store = OutboxSession.shared.outboxStore(user: Self.user, workspace: Self.workspace)
    entries = Self.initialEntries(options)
  }

  func stop() {
    completion?.resume(returning: #"{"state":"unknown"}"#)
    completion = nil
    control?.resume?.resume(returning: #"{"state":"not_applied"}"#)
    control = nil
    receive = nil
  }

  var record: OutboxRecord? { store?.snapshot.records.first { $0.sessionId == Self.sessionId } }

  var session: SessionItem {
    SessionItem(
      id: Self.sessionId, title: "Send handoff check", status: options.queue ? "running" : "idle", projectId: "fixture:local:project",
      createdAt: "2026-09-07T00:00:00Z", machineId: "fixture", cliType: "builtin", agentType: "fixture"
    )
  }

  var state: SessionListState {
    SessionListState(
      userId: Self.user, workspaceId: Self.workspace, connected: connected,
      catalog: SessionCatalog(projects: [SessionProject(id: "fixture:local:project", name: "Fixture")], sessions: [session])
    )
  }

  var feed: SessionFeedService {
    SessionFeedService(
      watch: { [weak self] _, receive in
        self?.receive = receive
        return { [weak self] in self?.receive = nil }
      },
      reconnect: { [weak self] _ in self?.connect() },
      cached: { [envelope = envelope()] _, _, _ in envelope }
    )
  }

  var environment: SessionSendEnvironment {
    SessionSendEnvironment(
      store: { [store] _, _ in store },
      services: { [weak self] in self?.services ?? OutboxSession.shared.services },
      inflight: OutboxSession.published.inflight,
      serverCreated: { _ in false },
      foreground: { _, _ in },
      control: { [weak self] payload in
        guard let self else { throw OutboxError.scopeExpired }
        return try await self.request(payload)
      },
      composer: SessionComposerService(
        options: { [steer = options.steer] _, _ in
          CreationOptions(sessionId: Self.sessionId, agents: [], capabilities: [
            Capability(machineId: "fixture", cliType: "builtin", agentType: "fixture", steer: steer),
          ])
        },
        tier: { _, _ in nil }
      )
    )
  }

  private var services: OutboxServices {
    OutboxServices(
      createSession: { [weak self] _ in try await self?.wait(nil) ?? #"{"state":"unknown"}"# },
      ensureSession: { _ in },
      sendSessionTurn: { [weak self] payload in
        let args = SessionSender.object((try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any]) ?? [:])
        return try await self?.wait((args?["id"]?.string ?? "", args?["guide"] == .bool(true))) ?? #"{"state":"unknown"}"#
      },
      releaseReserve: { _ in },
      alert: { [weak self] title, message in
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default))
        self?.presenter?.present(alert, animated: true)
      }
    )
  }

  private func wait(_ submission: (id: String, guide: Bool)?) async throws -> String {
    submitted = submission
    calls += 1
    changed?()
    return try await withCheckedThrowingContinuation { completion = $0 }
  }

  private func request(_ payload: String) async throws -> String {
    let args = (try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any]) ?? [:]
    let action = args["action"] as? String ?? "", messageId = args["messageId"] as? String
    controlRequest = payload
    if action == "steer" {
      mark(messageId) { $0["status"] = "pending_apply"; $0["delivery"] = "confirming" }
    }
    changed?()
    return try await withCheckedThrowingContinuation { control = (action, messageId, $0) }
  }

  func connect() {
    connected = true
    status = "live"
    emit()
  }

  func complete(failure: Bool) {
    if let control {
      // A lost receipt keeps the request so a later acceptance can still settle it, as the runtime does.
      self.control = failure ? (control.action, control.messageId, nil) : nil
      if failure, control.action == "steer" { mark(control.messageId) { $0["delivery"] = "unknown" } }
      if !failure { advanceQueue(control.messageId) }
      let outcome = ["stop": "stopped", "steer": "applied"][control.action] ?? ""
      control.resume?.resume(returning: SessionController.json(["state": failure ? "not_applied" : outcome]))
      return
    }
    if completion == nil, !guideReceipts.isEmpty {
      let id = guideReceipts.removeFirst()
      mark(id) {
        $0["status"] = failure ? "pending_apply" : "processing"
        $0["delivery"] = failure ? "unknown" : "accepted"
      }
      return
    }
    guard let resume = completion else { return }
    completion = nil
    guard let record else { return resume.resume(returning: Self.result(failure ? "not_sent" : "accepted", failure)) }
    let text = record.send["text"]?.string ?? ""
    if submitted?.guide == true {
      if !failure, let target = entries.last(where: { $0["role"] as? String == "assistant" && $0["finished"] as? Bool != true }) {
        guideReceipts.append(record.sendId)
        controlRequest = SessionController.json(["action": "steer", "turnId": target["id"] ?? "", "messageId": record.sendId])
        append(Self.user(record.sendId, text, status: "pending_apply", extra: ["delivery": "confirming"]))
        return resume.resume(returning: #"{"state":"uploaded","awaitingGuide":true}"#)
      }
      if !failure {
        controlRequest = SessionController.json(["action": "dispatch", "messageId": record.sendId])
        append(Self.user(record.sendId, text, status: "pending"))
      }
      return resume.resume(returning: Self.result(failure ? "not_sent" : "accepted", failure))
    }
    var state = failure ? "not_sent" : "accepted"
    if record.send["queue"] == .bool(true), !failure {
      state = "queued"
      append(Self.user(record.sendId, text, status: "queued", finished: false))
    }
    if record.creation != nil { state = failure ? "rejected" : "created" }
    var reply: [String: Any] = ["state": state, "session": [
      "id": Self.sessionId, "machineId": "fixture", "projectId": "fixture:local:project", "title": "Send handoff check",
      "status": "idle", "archived": false, "pinned": false, "createdAt": "2026-09-07T00:00:00Z",
      "cliType": "builtin", "agentType": "fixture",
    ]]
    if failure { reply["reason"] = "free_session_turn_limit_reached" }
    resume.resume(returning: SessionController.json(reply))
  }

  func reply(finished: Bool) {
    if options.queue { return advanceQueue(nil) }
    guard let record else { return }
    var user = Self.user(record.sendId, record.send["text"]?.string ?? "", status: "")
    user["startedAt"] = record.send["startedAt"].flatMap(Self.any)
    var items = user["items"] as? [[String: Any]] ?? []
    if case .array(let attachments)? = record.send["attachments"] {
      for (index, value) in attachments.enumerated() {
        let attachment = value.object ?? [:], kind = attachment["kind"]?.string ?? "file"
        items.append(["itemId": "attachment-\(index)", "type": kind, "rev": 0, kind: [
          "id": "server-\(attachment["id"]?.string ?? "")", "fileName": attachment["name"]?.string ?? "", "width": 800, "height": 600,
        ]])
      }
    }
    user["items"] = items
    let answer: [String: Any] = [
      "id": "\(record.sendId):reply", "role": "assistant", "userTurnId": record.sendId, "status": "", "finished": finished,
      "startedAt": Date().timeIntervalSince1970 * 1000, "rev": 0, "items": [],
    ]
    status = "live"
    entries += record.phase == "unknown" ? [answer] : [user, answer]
    emit()
  }

  func togglePending() {
    guard let store else { return }
    if record != nil {
      store.remove(Self.sessionId)
      return
    }
    store.put(OutboxRecord(session: session.outboxValue, send: [
      "id": .string("stale-pending"), "text": .string("Completed stale message"), "startedAt": .number(Date().timeIntervalSince1970 * 1000),
      "attachments": .array([]), "choice": .object([:]), "phase": .string("unknown"),
    ]))
  }

  func uploadProgress() {
    guard let record, record.phase == "sending", case .array(let attachments)? = record.send["attachments"] else { return }
    let step = uploadStep % 4
    uploadStep += 1
    let phase = ["uploading", "uploading", "verifying", "complete"][step]
    for (index, attachment) in attachments.enumerated() {
      let percent = step < 2 ? 25 + step * 40 + index : 100
      NotificationCenter.default.post(name: .lodyAttachmentUploadProgress, object: nil, userInfo: [
        "sessionId": Self.sessionId, "sendId": record.sendId, "attachmentId": attachment.object?["id"]?.string ?? "",
        "phase": step == 2 && index == 0 ? "complete" : phase, "percent": percent,
      ])
    }
  }

  func resetGuide() {
    let removal = store?.remove(Self.sessionId)
    Task { @MainActor [weak self] in
      _ = await removal?.result
      guard let self else { return }
      self.controlRequest = ""
      self.entries = self.entries.filter { $0["id"] as? String == "running-reply" }.map { $0.merging(["finished": false]) { $1 } }
      self.emit()
    }
  }

  private func advanceQueue(_ messageId: String?) {
    let next = entries.first { entry in
      guard let messageId else { return entry["status"] as? String == "queued" }
      return entry["id"] as? String == messageId
    }
    let nextId = next?["id"] as? String
    var history = entries.filter { $0["status"] as? String != "queued" && $0["id"] as? String != nextId }
      .map { $0.merging(["finished": true]) { $1 } }
    if let next, let nextId {
      history.append(next.merging(["status": "processing", "delivery": "accepted", "finished": true]) { $1 })
      history.append([
        "id": nextId + ":reply", "role": "assistant", "status": "processing", "finished": false, "rev": 0,
        "items": [["itemId": "text", "type": "text", "text": "Working on: " + nextId, "rev": 0]],
      ])
    }
    entries = history + entries.filter { $0["status"] as? String == "queued" && $0["id"] as? String != nextId }
    emit()
  }

  private func mark(_ id: String?, _ change: (inout [String: Any]) -> Void) {
    entries = entries.map { entry in
      guard entry["id"] as? String == id else { return entry }
      var next = entry
      change(&next)
      return next
    }
    emit()
  }

  private func append(_ entry: [String: Any]) {
    entries.append(entry)
    emit()
  }

  private func emit() {
    revision += 1
    if let session = envelope() {
      receive?(SessionRuntimeEvent(generation: 1, state: status, sessionId: Self.sessionId, session: session))
    }
    changed?()
  }

  private func envelope() -> String? {
    let object: [String: Any] = ["v": 1, "status": status, "revision": revision, "entries": entries]
    return (try? JSONSerialization.data(withJSONObject: object)).map { String(decoding: $0, as: UTF8.self) }
  }

  private static func result(_ state: String, _ failure: Bool) -> String {
    var value: [String: Any] = ["state": state]
    if failure { value["reason"] = "free_session_turn_limit_reached" }
    return SessionController.json(value)
  }

  private static func any(_ value: OutboxValue) -> Any? {
    guard let data = try? JSONEncoder().encode(value) else { return nil }
    return try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
  }

  static func user(_ id: String, _ text: String, status: String, finished: Bool = true, extra: [String: Any] = [:]) -> [String: Any] {
    ["id": id, "role": "user", "status": status, "finished": finished, "rev": 0,
     "items": [["itemId": "text", "type": "text", "text": text, "rev": 0]]].merging(extra) { $1 }
  }

  private static func initialEntries(_ options: Options) -> [[String: Any]] {
    var entries: [[String: Any]] = []
    if options.longContext {
      for (index, pair) in SendPreviewText.context.enumerated() {
        entries.append(user("send-context-\(index)-user", pair.user, status: "handled"))
        entries.append([
          "id": "send-context-\(index)-reply", "rev": 0, "role": "assistant", "status": "completed", "finished": true,
          "items": [["itemId": "text", "rev": 0, "type": "text", "text": pair.reply]],
        ])
      }
      entries.append(user("send-context-current-user", "Review the remaining send interactions before we implement the plan.", status: "handled"))
    }
    if options.queue || options.longContext {
      entries.append([
        "id": "running-reply", "role": "assistant", "status": "processing", "finished": !options.queue, "rev": 0,
        "items": [["itemId": "text", "type": "text", "rev": 0,
                   "text": options.longContext ? SendPreviewText.longReply : "The current reply is still running"]],
      ])
    }
    return entries
  }
}
