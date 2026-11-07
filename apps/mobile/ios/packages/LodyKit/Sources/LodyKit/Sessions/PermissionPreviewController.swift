import LodyCore
import UIKit

@MainActor
final class PermissionPreviewController: SessionController {
  private let fixture: PermissionFixture
  private let probe = UIView()

  init(waiting: Bool = false) {
    let fixture = PermissionFixture(waiting: waiting)
    self.fixture = fixture
    super.init(
      sessionId: "permission-preview",
      source: SessionSource(changes: [], read: { fixture.state }, write: { _, _, _ in }),
      feed: SessionFeedService(
        watch: { _, receive in fixture.watch(receive) }, reconnect: { _ in }, cached: { _, _, _ in nil }
      ),
      environment: Self.environment, permission: fixture.service
    )
  }

  private static var environment: SessionSendEnvironment {
    SessionSendEnvironment(
      store: { _, _ in nil },
      services: { OutboxServices(
        createSession: { _ in throw OutboxError.scopeExpired },
        ensureSession: { _ in throw OutboxError.scopeExpired },
        sendSessionTurn: { _ in throw OutboxError.scopeExpired },
        releaseReserve: { _ in }, alert: { _, _ in }
      ) },
      inflight: OutboxInflight(), serverCreated: { _ in true }, foreground: { _, _ in },
      control: { _ in throw OutboxError.scopeExpired },
      composer: SessionComposerService(options: { _, _ in throw OutboxError.scopeExpired }, tier: { _, _ in nil }),
      turn: { _ in throw OutboxError.scopeExpired }, readEdit: { _ in throw OutboxError.scopeExpired }
    )
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var persistsDraft: Bool { false }

  override func viewDidLoad() {
    super.viewDidLoad()
    probe.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
    probe.isAccessibilityElement = true
    probe.accessibilityIdentifier = "permission-preview-probe"
    view.addSubview(probe)
    fixture.changed = { [weak self] in self?.probe.accessibilityValue = self?.fixture.log.joined(separator: ",") }
    LodyNavigationHeader.of(navigationItem).leftItems = [UIBarButtonItem(title: "Fixtures", menu: UIMenu(children: [
      UIAction(title: "Permission request") { [weak self] _ in self?.fixture.request(questions: false) },
      UIAction(title: "Question request") { [weak self] _ in self?.fixture.request(questions: true) },
      UIAction(title: "Remote answer") { [weak self] _ in self?.fixture.remote() },
      UIAction(title: "Request replacement") { [weak self] _ in self?.fixture.replacement() },
    ]))]
  }
}

@MainActor
final class PermissionFixture {
  var changed: (() -> Void)?
  var log: [String] = []
  private var receive: (@MainActor (SessionRuntimeEvent) -> Void)?
  private var revision = 0
  private var requestId = 0
  private var current: [String: Any]?
  private var attempts = 0
  private var replacing = false
  private let waiting: Bool
  private let deferred: Bool

  init(waiting: Bool, deferred: Bool = false) {
    self.waiting = waiting
    self.deferred = deferred
    if waiting { request(questions: false) }
  }

  var state: SessionListState {
    SessionListState(
      userId: "preview-user", workspaceId: "preview-workspace",
      catalog: SessionCatalog(sessions: [SessionItem(
        id: "permission-preview", title: "Permission preview", status: "idle", projectId: "chat", awaitingUserSince: waiting ? 1 : nil, machineId: "preview-mac"
      )])
    )
  }

  var service: PermissionService {
    PermissionService(
      detail: { _, target in .init(itemId: target.itemId, rev: 1, blocks: [
        .object(["type": .string("terminal_command"), "command": .string("pnpm check")]),
      ], truncated: false) },
      respond: { [self] params in
        attempts += 1
        log.append("submit:\(params.requestId):\(attempts)")
        if let answers = params.answers {
          let data = try JSONEncoder().encode(answers)
          log.append(String(decoding: data, as: UTF8.self))
        }
        changed?()
        if replacing {
          replacing = false
          request(questions: false)
          // Simulate a network reply that cannot be cancelled by closing its UI task.
          await withCheckedContinuation { continuation in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { continuation.resume() }
          }
          return .accepted
        }
        if params.answers != nil, attempts == 1 { throw NSError(domain: "Fixture upload failure", code: 1) }
        current = nil
        // The accepted result may arrive before the next replica update.
        Task { [weak self] in
          try await Task.sleep(for: .milliseconds(500))
          self?.emit()
        }
        return .accepted
      }
    )
  }

  func watch(_ receive: @escaping @MainActor (SessionRuntimeEvent) -> Void) -> @MainActor () -> Void {
    self.receive = receive
    if waiting {
      Task { [weak self] in
        try await Task.sleep(for: .seconds(2))
        self?.emit()
      }
    } else if !deferred {
      emit()
    }
    return { [weak self] in self?.receive = nil }
  }

  func request(questions: Bool) {
    requestId += 1
    attempts = 0
    var permission: [String: Any] = [
      "pending": true, "requestId": "request-\(requestId)",
      "options": [["optionId": "allow", "name": "Allow once", "kind": "allow_once"],
                  ["optionId": "custom", "name": "Custom choice"]],
    ]
    if questions {
      permission["kind"] = "ask_user_question"
      permission["questionMeta"] = [
        "allowCustomAnswer": true,
        "questions": [
          ["id": "language", "header": "Language", "question": "Which language should we use?", "multiSelect": false,
           "options": [["label": "Swift"], ["label": "TypeScript"]]],
          ["id": "checks", "header": "Checks", "question": "Which checks should run?", "multiSelect": true,
           "options": [["label": "Unit tests"], ["label": "UI tests"]]],
          ["id": "notes", "header": "Notes", "question": "Anything else we should know?", "multiSelect": false, "options": []],
        ],
      ]
    }
    current = ["type": "tool_call", "itemId": "tool", "kind": "execute", "title": "Run checks \(requestId)", "permission": permission]
    log.append("request:\(requestId)")
    emit()
  }

  func remote() {
    request(questions: false)
    Task { [weak self] in
      try await Task.sleep(for: .seconds(4))
      self?.current = nil
      self?.log.append("remote")
      self?.emit()
    }
  }

  func replacement() {
    replacing = true
    request(questions: false)
  }

  func resolve() {
    current = nil
    emit()
  }

  func suspend() { emit(status: "syncing") }
  func resume() { emit() }

  private func emit(status: String = "live") {
    revision += 1
    let envelope: [String: Any] = [
      "v": 1, "revision": revision, "status": status, "entries": [
        ["id": "entry", "role": "assistant", "status": "completed", "finished": true, "items": current.map { [$0] } ?? []],
      ],
    ]
    receive?(.init(generation: 1, state: "live", sessionId: "permission-preview", session: SessionController.json(envelope)))
    changed?()
  }
}
