import UIKit

@MainActor
final class SendPreviewController: SessionController {
  private let fixture: SendPreviewFixture
  private let controls = UIStackView()
  private let statusLabel = UILabel()
  private let queueLabel = UILabel()
  private let requestLabel = UILabel()
  private var outboxObserver: NSObjectProtocol?

  init(params: [String: Any]) {
    let fixture = SendPreviewFixture(options: .init(
      queue: params["queue"] as? Bool == true, steer: params["steer"] as? Bool != false,
      behavior: params["queuedMessageBehavior"] as? String == "guide" ? "guide" : "queue",
      longContext: params["longContext"] as? Bool == true
    ))
    self.fixture = fixture
    super.init(
      sessionId: SendPreviewFixture.sessionId,
      source: SessionSource(changes: [SendPreviewFixture.change], read: { fixture.state }, write: { _, _, _ in }),
      feed: fixture.feed, environment: fixture.environment
    )
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    fixture.stop()
    if let outboxObserver { NotificationCenter.default.removeObserver(outboxObserver) }
  }

  override var queuedMessageBehavior: String { fixture.options.behavior }
  override var persistsDraft: Bool { false }

  override func adjustComposer(_ state: inout [String: Any]) {
    state["connection"] = ""
    state["placeholder"] = "Offline sending works too"
  }

  override var resourceItems: [[String: Any]] {
    guard fixture.contextChip else { return [] }
    return [["id": "browser", "symbol": "safari", "tap": true, "tint": "primary", "accessibilityLabel": "localhost:5173"]]
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    fixture.presenter = self
    let options = fixture.options
    if fixture.record == nil, !options.queue, !options.longContext {
      chat.setInitialAttachments(#"[{"id":"fixture-file","name":"fixture.txt","uri":"file:///tmp/lody-ui-fixture.txt","kind":"file"}]"#)
    }
    var buttons: [(String, String, () -> Void)] = [
      ("send-connect", "Live", { [weak self] in self?.fixture.connect() }),
      ("send-complete", "Ack", { [weak self] in self?.fixture.complete(failure: false) }),
      ("send-fail", "Fail", { [weak self] in self?.fixture.complete(failure: true) }),
      ("send-start-reply", "Start", { [weak self] in self?.fixture.reply(finished: false) }),
      ("send-reply", "Reply", { [weak self] in self?.fixture.reply(finished: true) }),
    ]
    if options.queue {
      buttons.append(("send-toggle-context", "Ctx", { [weak self] in
        guard let self else { return }
        self.fixture.contextChip.toggle()
        self.renderComposer()
      }))
    } else {
      buttons.append(("send-toggle-pending", "Stale", { [weak self] in self?.fixture.togglePending() }))
    }
    buttons.append(("send-upload-progress", "Upl", { [weak self] in self?.fixture.uploadProgress() }))
    let row = UIStackView(arrangedSubviews: buttons.map { Self.button(id: $0.0, title: $0.1, action: $0.2) })
    row.spacing = 6
    controls.axis = .vertical
    controls.alignment = .leading
    controls.addArrangedSubview(row)
    if options.behavior == "guide" {
      controls.addArrangedSubview(Self.button(id: "send-reset-guide", title: "Reset guide") { [weak self] in self?.fixture.resetGuide() })
    }
    for (label, id, shown) in [(statusLabel, "send-status", true), (queueLabel, "queue-count", options.queue), (requestLabel, "control-request", options.queue)] where shown {
      label.accessibilityIdentifier = id
      label.font = .preferredFont(forTextStyle: .body)
      label.textColor = .label
      controls.addArrangedSubview(label)
    }
    controls.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(controls)
    chat.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      // The transparent navigation bar's hit region extends past its title; keep fixture controls clear of it.
      controls.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 18),
      controls.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      controls.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -16),
      chat.topAnchor.constraint(equalTo: controls.bottomAnchor, constant: 8),
      chat.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      chat.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      chat.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    chat.setEmptyText("Offline send check")
    fixture.changed = { [weak self] in
      NotificationCenter.default.post(name: SendPreviewFixture.change, object: nil)
      self?.updateLabels()
    }
    outboxObserver = NotificationCenter.default.addObserver(forName: .lodyOutboxDidChange, object: fixture.store, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.updateLabels() }
    }
    updateLabels()
  }

  private func updateLabels() {
    statusLabel.text = "Calls: \(fixture.calls) · \(fixture.record?.phase ?? "idle")"
    queueLabel.text = "Queue: \(fixture.entries.filter { $0["status"] as? String == "queued" }.count)"
    requestLabel.text = fixture.controlRequest
  }

  private static func button(id: String, title: String, action: @escaping () -> Void) -> UIButton {
    var configuration = UIButton.Configuration.gray()
    configuration.attributedTitle = AttributedString(title, attributes: AttributeContainer([.font: UIFont.preferredFont(forTextStyle: .footnote)]))
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 4, bottom: 10, trailing: 4)
    let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
    button.accessibilityIdentifier = id
    button.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    return button
  }
}

extension SendPreviewFixture {
  static let change = Notification.Name("LodySendPreviewFixture")
}

enum SendPreviewText {
  static let context: [(user: String, reply: String)] = [
    ("Help me redesign the project browser. Start with the navigation and explain the tradeoffs.",
     "The project browser should keep the current workspace visible while the project list changes. A project row opens its session list with the native back gesture, so returning restores the same scroll position. Search belongs above the list and should keep its query when a session is opened.\n\nEach project needs a readable name, a short repository path, and a clear connection state. The row should remain useful when the computer is offline: cached sessions can still open, while actions that require the computer explain what is missing. Avoid replacing the entire page with a connection error.\n\nFor the first pass, keep the hierarchy shallow. Workspace selection changes the catalog; opening a project changes only the native stack. This makes the ownership of selection and navigation easier to follow."),
    ("What should happen when the catalog refreshes while I am reading the middle of the list?",
     "Keep the visible project anchored by identity rather than by its numeric index. New projects may appear before it, but they should not move the text the user is reading. A refresh indicator can appear in the navigation area without inserting a large row above the content.\n\nSelection should survive a snapshot update. If the selected project is removed, finish the current navigation transition before changing the selection. An interactive back gesture that is cancelled must restore the row highlight, because the destination still owns the screen.\n\nA failed refresh should leave the cached rows in place and offer an explicit retry. Show when those rows were last updated. An empty response is different from a failed request: only a confirmed successful response should replace the list with the empty state."),
    ("Now cover message drafts, attachments, and what the user sees during a failed send.",
     "Treat the draft text and its attachments as one unit. The local message should appear immediately with a stable identity, and the authoritative history should take over that same message after delivery. Clearing the input must not delete the only copy of a draft that is still being prepared.\n\nBefore a durable write, a definite failure can offer an explicit retry with the original text and files. After an uncertain acknowledgement, keep the message visible and explain that delivery is unconfirmed. Do not replay the write automatically, because the computer may already have accepted it.\n\nThe conversation should remain readable through each transition. An ordinary new turn can reserve room for its reply. Guidance added to the reply already in progress should stay beside that context, without opening a new empty viewport beneath it."),
  ]
  static let longReply =
    "I am checking the message list against the project-browser plan. The earlier decisions still apply: preserve the reading position, retain the local message identity, and make delivery failures visible without discarding the draft.\n\nThe first check is an ordinary new turn. Its message moves to the top of the transcript, leaving room for the answer. With several screens of history above it, that movement should be easy to distinguish from simply appending a row at the bottom.\n\nThe second check is guidance during this reply. The existing paragraphs should remain directly above the new message. The list may advance enough to reveal the message, but it should not push that message to the top or reserve another screen of empty space.\n\nCurrent checkpoint: keep this paragraph visible immediately above the next message. I am still reviewing the remaining interaction details."
}
