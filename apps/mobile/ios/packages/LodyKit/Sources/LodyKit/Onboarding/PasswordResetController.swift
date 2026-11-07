import UIKit

@MainActor
final class PasswordResetController: UIViewController {
  private let api: AuthAPI
  private let email = UITextField()
  private let message = UILabel()
  private let submit = UIButton(type: .system)
  private let cancelButton = UIButton(type: .system)
  private let progress = UIActivityIndicatorView(style: .medium)
  private let scroll = UIScrollView()
  private(set) var task: Task<Void, Never>?
  private var generation = 0
  private var completed = false

  init(api: AuthAPI = AuthAPI()) {
    self.api = api
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "auth.reset.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    view.accessibilityIdentifier = "auth-reset-page"
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.keyboardDismissMode = .interactive
    view.addSubview(scroll)
    let stack = UIStackView()
    stack.axis = .vertical
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -24),
    ])
    configure(email, "auth.native.email", content: .emailAddress)
    email.keyboardType = .emailAddress
    stack.addArrangedSubview(email)
    message.font = .preferredFont(forTextStyle: .body)
    message.adjustsFontForContentSizeCategory = true
    message.numberOfLines = 0
    message.accessibilityIdentifier = "auth-reset-message"
    show("auth.reset.requestHint")
    stack.addArrangedSubview(message)
    var configuration = UIButton.Configuration.filled()
    configuration.title = text("auth.reset.send")
    configuration.baseBackgroundColor = .systemBlue
    submit.configuration = configuration
    submit.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
    submit.accessibilityIdentifier = "auth-reset-submit"
    submit.addAction(UIAction { [weak self] _ in self?.perform() }, for: .touchUpInside)
    stack.addArrangedSubview(submit)
    stack.addArrangedSubview(progress)
    cancelButton.setTitle(String(localized: "common.cancel", bundle: .lody), for: .normal)
    cancelButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    cancelButton.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.discard()
      LodyShell.shared.close(from: self)
    }, for: .touchUpInside)
    stack.addArrangedSubview(cancelButton)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    LodyScrollEdges.bind(scroll, to: self)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isMovingFromParent || navigationController?.isBeingDismissed == true || isBeingDismissed { discard() }
  }

  private func discard() {
    generation += 1
    task?.cancel()
    task = nil
  }

  private func configure(_ field: UITextField, _ key: String, content: UITextContentType) {
    field.placeholder = text(key)
    field.accessibilityLabel = field.placeholder
    field.accessibilityIdentifier = key
    field.textContentType = content
    field.autocapitalizationType = .none
    field.autocorrectionType = .no
    field.borderStyle = .roundedRect
    field.font = .preferredFont(forTextStyle: .body)
    field.adjustsFontForContentSizeCategory = true
    field.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
  }

  private func perform() {
    guard task == nil else { return }
    if completed { LodyShell.shared.close(from: self); return }
    let address = (email.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !address.contains("@") {
      show("auth.native.fields", error: true)
      return
    }
    view.endEditing(true)
    setBusy(true)
    generation += 1
    let id = generation
    task = Task { [weak self, api] in
      do {
        try await api.requestPasswordReset(email: address)
        try Task.checkCancellation()
        guard let self, self.generation == id else { return }
        self.completed = true
        self.show("auth.reset.sent")
        self.email.isHidden = true
        self.submit.configuration?.title = self.text("auth.reset.done")
      } catch {
        guard let self, self.generation == id, !Task.isCancelled else { return }
        self.message.text = (error as? AuthFailure)?.message ?? self.text("auth.reset.failed")
        self.message.textColor = .systemRed
      }
      guard let self, self.generation == id else { return }
      self.task = nil
      self.setBusy(false)
    }
  }

  private func setBusy(_ busy: Bool) {
    submit.isEnabled = !busy
    email.isEnabled = !busy
    if busy { progress.startAnimating() } else { progress.stopAnimating() }
  }

  private func show(_ key: String, error: Bool = false) {
    message.text = text(key)
    message.textColor = error ? .systemRed : .secondaryLabel
  }

  private func text(_ key: String) -> String {
    String(localized: String.LocalizationValue(key), bundle: .lody)
  }
}
