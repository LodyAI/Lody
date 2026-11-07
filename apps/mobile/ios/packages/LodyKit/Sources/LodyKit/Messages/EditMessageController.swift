import LodyCore
import UIKit

@MainActor
class EditMessageController: UIViewController {
  private enum Phase { case loading, loadFailed, ready, sending, unknown, checking, closed }
  private let scope: EditMessageScope
  private let service: EditMessageService
  private var phase = Phase.loading
  private var draft: EditMessageDraft?
  private var replacement: String?
  private var task: Task<Void, Never>?
  private var restoreToken = 0
  private let composer = ChatComposerView(frame: .zero)
  private let host = UIView()
  private lazy var hostHeight = host.heightAnchor.constraint(equalToConstant: 0)
  private let errorLabel = UILabel()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let retry = UIButton(type: .system)
  private lazy var cancelItem = LodyFormController.barButton(
    symbol: "xmark", label: String(localized: "common.cancel", bundle: .lody)
  ) { [weak self] in self?.close() }
  var onFinish: ((String) -> Void)?

  init(sessionId: String, entryId: String, service: EditMessageService = .live) {
    scope = EditMessageScope(sessionId: sessionId, expectedUserTurnId: entryId)
    self.service = service
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { task?.cancel() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let notice = UILabel()
    notice.text = String(localized: "chat.edit.notice", bundle: .lody)
    for label in [notice, errorLabel] {
      label.font = .preferredFont(forTextStyle: .footnote)
      label.adjustsFontForContentSizeCategory = true
      label.textColor = .secondaryLabel
      label.numberOfLines = 0
    }
    errorLabel.accessibilityIdentifier = "edit-message-error"
    spinner.accessibilityIdentifier = "edit-message-busy"
    retry.accessibilityIdentifier = "edit-message-retry"
    retry.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      if phase == .unknown { check() } else { prepare() }
    }, for: .touchUpInside)
    let footer = UIStackView(arrangedSubviews: [notice, errorLabel, spinner, retry])
    footer.axis = .vertical
    footer.spacing = 8
    for child in [host, footer] {
      child.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(child)
    }
    NSLayoutConstraint.activate([
      host.leadingAnchor.constraint(equalTo: view.leadingAnchor), host.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      host.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor), hostHeight,
      footer.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      footer.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      footer.bottomAnchor.constraint(equalTo: host.topAnchor, constant: -12),
      retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])
    composer.sendHandoff = false
    composer.setInputIdentifier("edit-message-input")
    composer.onHeightChange = { [weak self] height in self?.hostHeight.constant = height }
    composer.onSend = { [weak self] payload in
      // This event is produced by the shared native composer, not external input.
      let value = try! JSONDecoder().decode(EditMessageSubmission.self, from: JSONSerialization.data(withJSONObject: payload))
      self?.send(value)
    }
    prepare()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    parent?.navigationItem.leftBarButtonItems = [cancelItem]
    parent?.navigationItem.rightBarButtonItems = []
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if SettingsPage.leaving(self) { phase = .closed; task?.cancel() }
  }

  private func prepare() {
    precondition(draft == nil)
    phase = .loading
    errorLabel.text = nil
    render()
    task = Task { [weak self, service, scope] in
      do {
        let value = try await service.prepare(scope)
        guard let self, !Task.isCancelled, phase != .closed else { return }
        draft = value
        phase = .ready
        composer.setInitialDraft(value.text)
        composer.setInitialAttachments(String(decoding: try JSONEncoder().encode(value.attachments), as: UTF8.self))
        render()
        composer.autoFocus = true
        composer.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(composer)
        NSLayoutConstraint.activate([
          composer.topAnchor.constraint(equalTo: host.topAnchor), composer.leadingAnchor.constraint(equalTo: host.leadingAnchor),
          composer.trailingAnchor.constraint(equalTo: host.trailingAnchor),
        ])
      } catch {
        guard let self, !Task.isCancelled, phase != .closed else { return }
        record(error, action: "prepare_failed")
        phase = .loadFailed
        errorLabel.text = String(localized: "chat.edit.loadFailed", bundle: .lody)
        render()
      }
    }
  }

  private func send(_ value: EditMessageSubmission) {
    precondition(phase == .ready && draft != nil)
    phase = .sending
    replacement = value.id
    errorLabel.text = nil
    render()
    let originals = Set(draft!.attachments.map(\.id))
    task = Task { [weak self, service, scope] in
      let result: RuntimeContract.EditSessionResult
      do { result = try await service.send(scope, value, originals) }
      catch {
        self?.record(error, action: "send_failed")
        result = .unknown(.init())
      }
      guard let self, !Task.isCancelled, phase != .closed else { return }
      if case .accepted(let accepted) = result { finish(accepted.id); return }
      restoreToken += 1
      composer.restoreDraft(token: restoreToken)
      switch result {
      case .notSent: phase = .ready; errorLabel.text = String(localized: "chat.edit.failed", bundle: .lody)
      case .unknown: phase = .unknown; errorLabel.text = String(localized: "chat.edit.unknown", bundle: .lody)
      case .ready, .accepted: preconditionFailure("Unexpected edit send result")
      }
      render()
    }
  }

  private func check() {
    precondition(phase == .unknown && replacement != nil)
    phase = .checking
    render()
    var request = scope
    request.id = replacement
    task = Task { [weak self, service] in
      do {
        let result = try await service.read(request)
        guard let self, !Task.isCancelled, phase != .closed else { return }
        if case .accepted(let accepted) = result { finish(accepted.id); return }
      } catch { self?.record(error, action: "read_failed") }
      guard let self, !Task.isCancelled, phase != .closed else { return }
      phase = .unknown
      errorLabel.text = String(localized: "chat.edit.unknown", bundle: .lody)
      render()
    }
  }

  private func render() {
    let busy = phase == .loading || phase == .sending || phase == .checking
    cancelItem.isEnabled = !(busy && draft != nil)
    errorLabel.isHidden = errorLabel.text?.isEmpty != false
    spinner.isHidden = !busy
    if busy { spinner.startAnimating() } else { spinner.stopAnimating() }
    retry.isHidden = phase != .loadFailed && phase != .unknown
    retry.setTitle(String(localized: String.LocalizationValue(phase == .loadFailed ? "chat.edit.retry" : "chat.edit.check"), bundle: .lody), for: .normal)
    composer.setComposerState(SessionController.json([
      "editable": phase == .ready || phase == .sending, "canSend": phase == .ready,
      "sending": phase == .sending, "notice": "", "reconnect": false, "placeholder": String(localized: "chat.edit.title", bundle: .lody),
    ]))
  }

  private func finish(_ id: String) {
    LodyShell.shared.finish(from: self, value: id)
    onFinish?(id)
    close()
  }

  private func close() {
    phase = .closed
    task?.cancel()
    view.endEditing(true)
    dismiss(animated: true)
  }

  private func record(_ error: Error, action: StaticString) {
    DiagnosticsStore.shared.record("edit_message", action, fields: ["code": String((error as NSError).code)])
  }
}
