import LodyCore
import UIKit

@MainActor
final class EditMessagePreviewController: UIViewController {
  private let chat = LodyChatView(frame: .zero)
  private let count = UILabel()
  private let payload = UILabel()
  private let scenario: String
  private var attempts = 0
  private var reads = 0
  private var prepares = 0
  private var submitted: EditMessageSubmission?
  private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)

  init(scenario: String = "retry") {
    self.scenario = scenario
    super.init(nibName: nil, bundle: nil)
    try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    for name in ["original.txt", "keep.txt"] {
      try! "Offline editor fixture".write(to: directory.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { try? FileManager.default.removeItem(at: directory) }

  override func viewDidLoad() {
    super.viewDidLoad()
    chat.frame = view.bounds
    chat.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(chat)
    chat.setInitialDraft("Keep this chat draft")
    chat.setComposerState(SessionController.json(["editable": true, "canSend": true, "sending": false, "notice": "", "reconnect": false, "placeholder": ""]))
    chat.editableMessageID = "editable"
    chat.onEditMessage = { [weak self] body in
      guard let self, let id = body["entryId"] as? String else { return }
      openEditor(id)
    }
    for (label, id) in [(count, "edit-fixture-count"), (payload, "edit-fixture-payload")] {
      label.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
      label.isAccessibilityElement = true
      label.accessibilityIdentifier = id
      view.addSubview(label)
    }
    count.accessibilityLabel = "0"
    render()
  }

  private func openEditor(_ entryId: String) {
    let service = EditMessageService(
      prepare: { [self] _ in
        prepares += 1
        if scenario == "load-failure", prepares == 1 { throw CocoaError(.fileReadUnknown) }
        return EditMessageDraft(state: "ready", text: "Original prompt", attachments: [
          .init(id: "original:0", name: "original.txt", uri: directory.appendingPathComponent("original.txt").absoluteString, kind: "file"),
          .init(id: "original:1", name: "keep.txt", uri: directory.appendingPathComponent("keep.txt").absoluteString, kind: "file"),
        ])
      },
      send: { [self] scope, value, originals in
        submitted = value
        payload.accessibilityLabel = try value.payload(scope: scope, originals: originals)
        attempts += 1
        count.accessibilityLabel = String(attempts)
        try await Task.sleep(for: .milliseconds(1500))
        if scenario == "unknown" { return .unknown(.init()) }
        if attempts == 1 { return .notSent(.init(reason: "Fixture send failed")) }
        return .accepted(.init(id: value.id))
      },
      read: { [self] scope in
        reads += 1
        precondition(scope.id == submitted?.id)
        // First read is still uncertain. Neither read may issue another write.
        if reads == 1 { return .unknown(.init()) }
        return .accepted(.init(id: submitted!.id))
      }
    )
    let page = EditMessageController(sessionId: "edit-preview", entryId: entryId, service: service)
    page.onFinish = { [weak self] id in
      guard let self else { return }
      chat.editableMessageID = ""
      chat.editedMessageID = id
      render(replacement: submitted)
    }
    LodyShell.shared.presentNative(page, title: String(localized: "chat.edit.title", bundle: .lody), dismissible: false, style: "fullScreen")
  }

  private func render(replacement: EditMessageSubmission? = nil) {
    var values = [
      ("earlier", "user", "Earlier message stays read-only."),
      ("prior-reply", "assistant", "Previous answer."),
    ]
    if let replacement { values.append((replacement.id, "user", replacement.text)) }
    else {
      values += [("editable", "user", "Original prompt"), ("old-reply", "assistant", "This reply will be replaced.")]
    }
    let entries = values.map { id, role, text -> [String: Any] in
      ["id": id, "role": role, "finished": true, "status": "completed", "rev": 1,
       "items": [["type": "text", "text": text, "itemId": "text", "rev": 1]]]
    }
    chat.setEntries(String(decoding: try! JSONSerialization.data(withJSONObject: entries), as: UTF8.self))
    chat.scheduleUpdate()
  }
}
