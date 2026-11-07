import LodyCore
import UIKit

@MainActor
final class AgentErrorPreviewController: SessionController {
  private static let sessionId = "error-preview"
  private let payloadLabel = UILabel()
  private let countLabel = UILabel()
  private var attempts = 0

  init() {
    let environment = SessionSendEnvironment(
      store: { OutboxSession.shared.outboxStore(user: $0, workspace: $1) },
      services: { OutboxSession.shared.services },
      inflight: OutboxSession.published.inflight,
      serverCreated: { _ in false },
      foreground: { _, _ in },
      control: { _ in throw OutboxError.scopeExpired },
      composer: SessionComposerService(options: { _, _ in throw OutboxError.scopeExpired }, tier: { _, _ in nil })
    )
    let session = SessionItem(
      id: Self.sessionId, title: "Agent error preview", status: "idle", projectId: "fixture:local:project",
      machineId: "fixture", cliType: "builtin", agentType: "fixture"
    )
    let state = SessionListState(
      userId: "ui-error-preview", workspaceId: "fixture", catalog: SessionCatalog(projects: [], sessions: [session])
    )
    super.init(
      sessionId: Self.sessionId, source: SessionSource(changes: [], read: { state }, write: { _, _, _ in }),
      feed: SessionFeedService(
        watch: { _, receive in
          DispatchQueue.main.async {
            MainActor.assumeIsolated {
              receive(SessionRuntimeEvent(generation: 1, state: "live", sessionId: Self.sessionId, session: Self.envelope))
            }
          }
          return {}
        },
        reconnect: { _ in }, cached: { _, _, _ in nil }
      ),
      environment: environment
    )
    self.environment.turn = { [weak self] payload in try await self?.turn(payload) ?? "" }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var persistsDraft: Bool { false }

  override func adjustComposer(_ state: inout [String: Any]) {
    state["connection"] = ""
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    chat.setInitialDraft("Keep this draft")
    let labels = UIStackView(arrangedSubviews: [payloadLabel, countLabel])
    labels.axis = .vertical
    for (label, id) in [(payloadLabel, "error-retry-payload"), (countLabel, "error-retry-count")] {
      label.accessibilityIdentifier = id
      label.font = .systemFont(ofSize: 10)
      label.textColor = .secondaryLabel
      label.heightAnchor.constraint(equalToConstant: 14).isActive = true
    }
    labels.translatesAutoresizingMaskIntoConstraints = false
    chat.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(labels)
    NSLayoutConstraint.activate([
      chat.topAnchor.constraint(equalTo: view.topAnchor),
      chat.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      chat.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      chat.bottomAnchor.constraint(equalTo: labels.topAnchor),
      labels.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      labels.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      labels.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
    ])
    update(payload: "")
  }

  private func update(payload: String) {
    payloadLabel.text = "Last retry request"
    payloadLabel.accessibilityLabel = payload
    countLabel.text = "Retry attempts: \(attempts)"
    countLabel.accessibilityLabel = String(attempts)
  }

  private func turn(_ payload: String) async throws -> String {
    attempts += 1
    let attempt = attempts
    update(payload: payload)
    try await Task.sleep(for: .seconds(12))
    return attempt == 1 ? #"{"state":"not_sent"}"# : #"{"state":"accepted"}"#
  }

  private static let envelope: String? = {
    func failure(_ meta: [String: Any]?) -> [String: Any] {
      var item: [String: Any] = ["itemId": "failure", "type": "system_notice", "name": "chat_failed"]
      item["meta"] = meta
      return item
    }
    let entries: [[String: Any]] = [
      [
        "id": "error-assistant", "status": "completed", "role": "assistant", "finished": true,
        "items": [
          ["itemId": "text", "type": "text", "text": "Completed answer remains visible."],
          failure(["reason": "future_reason", "code": "future_code", "message": "Unrecognized provider error preserved."]),
        ],
      ],
      ["id": "error-missing", "status": "completed", "role": "system", "finished": true, "items": [failure(nil)]],
      [
        "id": "error-system", "status": "completed", "role": "system", "finished": true,
        "items": [failure([
          "reason": "acp_provider_overloaded",
          "message": "Upstream request failed: 429\nProvider capacity exhausted.\nRequest ID: fixture-429",
        ])],
      ],
    ]
    let object: [String: Any] = ["v": 1, "status": "live", "revision": 1, "entries": entries]
    return (try? JSONSerialization.data(withJSONObject: object)).map { String(decoding: $0, as: UTF8.self) }
  }()
}
