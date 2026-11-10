import UIKit

@MainActor
final class PullRequestCommentController: LodyFormController {
  private let store: PullRequestStore
  private let input = LodyFormTextView(id: "pr-comment-input", label: String(localized: "pr.comment", bundle: .lody), text: nil, limit: 65536, minHeight: 160)
  private var sending = false
  private var unknown = false
  private lazy var send = Self.barButton(title: String(localized: "pr.send", bundle: .lody), label: String(localized: "pr.send", bundle: .lody), prominent: true) { [weak self] in self?.submit() }
  private lazy var cancel = Self.barButton(title: String(localized: "common.cancel", bundle: .lody), label: String(localized: "common.cancel", bundle: .lody)) { [weak self] in self?.cancelEdit() }

  init(store: PullRequestStore) { self.store = store; super.init(nibName: nil, bundle: nil) }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    input.changed = { [weak self] in self?.render() }
    stack.addArrangedSubview(LodyFormGroup(header: "\(store.repository) · PR #\(store.number)", footer: String(localized: "pr.commentPlaceholder", bundle: .lody), input))
    store.watch(self) { [weak self] in self?.render() }
  }
  override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); input.becomeFirstResponder() }
  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    header?.rightBarButtonItems = [send]; header?.leftBarButtonItems = [cancel]
    render()
  }
  private func render() {
    send.isEnabled = !input.trimmed.isEmpty && !sending && !unknown && store.valid
    cancel.isEnabled = !sending
    input.isEditable = !sending
  }
  private func cancelEdit() {
    guard !sending else { return }
    if input.trimmed.isEmpty { closeForm(); return }
    SettingsPage.confirm(from: self, title: String(localized: "pr.discard", bundle: .lody), message: "", action: String(localized: "pr.discard", bundle: .lody), destructive: true) { [weak self] in self?.closeForm() }
  }
  private func submit() {
    guard send.isEnabled else { return }
    sending = true; render()
    Task { [weak self] in
      guard let self else { return }
      defer { sending = false; render() }
      do {
        if try await store.comment(input.trimmed) { closeForm() }
        else { show(String(localized: "pr.previewAction", bundle: .lody)) }
      } catch {
        unknown = error.localizedDescription.contains("comment_unknown")
        show(PullRequestStore.errorText(error.localizedDescription))
      }
    }
  }
  private func show(_ message: String) {
    let alert = UIAlertController(title: String(localized: "pr.comment", bundle: .lody), message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default))
    present(alert, animated: true)
  }
}
