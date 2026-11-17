import UIKit

/// Requests a password-reset email, in the sign-in page's language: a title,
/// a description, the email field and one primary action. The reset itself
/// completes on the HTTPS website (see `docs/native-auth.md`).
@MainActor
final class PasswordResetController: UIViewController {
  private let api: AuthAPI
  private let emailField = LoginField(label: String(localized: "auth.login.emailLabel", bundle: .lody))
  private let message = UILabel()
  private let submit = LoginButton(.primary, title: String(localized: "auth.reset.send", bundle: .lody), centered: true)
  private let cancelButton = LoginButton(.ghost, title: String(localized: "common.cancel", bundle: .lody), centered: true)
  private let scroll = UIScrollView()
  private(set) var task: Task<Void, Never>?
  private var generation = 0
  private var completed = false

  private var email: UITextField { emailField.field }

  init(api: AuthAPI = AuthAPI(), email: String = "") {
    self.api = api
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "auth.reset.title", bundle: .lody)
    self.email.text = email
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = LoginPalette.page
    view.accessibilityIdentifier = "auth-reset-page"
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.keyboardDismissMode = .interactive
    view.addSubview(scroll)
    let heading = UILabel()
    heading.attributedText = NSAttributedString(string: title ?? "", attributes: [.kern: -0.6])
    heading.font = LoginType.font(24, .semibold, style: .title2)
    heading.adjustsFontForContentSizeCategory = true
    heading.textColor = LoginPalette.label
    heading.accessibilityTraits = .header
    heading.numberOfLines = 0
    message.font = LoginType.description
    message.adjustsFontForContentSizeCategory = true
    message.numberOfLines = 0
    message.accessibilityIdentifier = "auth-reset-message"
    show("auth.reset.description")
    email.placeholder = String(localized: "auth.login.emailPlaceholder", bundle: .lody)
    email.accessibilityIdentifier = "auth.native.email"
    email.textContentType = .emailAddress
    email.keyboardType = .emailAddress
    submit.accessibilityIdentifier = "auth-reset-submit"
    submit.addAction(UIAction { [weak self] _ in self?.perform() }, for: .touchUpInside)
    cancelButton.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.discard()
      LodyShell.shared.close(from: self)
    }, for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [heading, message, emailField, submit, cancelButton])
    stack.axis = .vertical
    stack.spacing = 24
    stack.setCustomSpacing(8, after: heading)
    stack.setCustomSpacing(16, after: emailField)
    stack.setCustomSpacing(4, after: submit)
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

  private func perform() {
    guard task == nil else { return }
    if completed { LodyShell.shared.close(from: self); return }
    let address = (email.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !address.contains("@") {
      show("auth.login.emailInvalid", error: true)
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
        self.emailField.isHidden = true
        self.cancelButton.isHidden = true
        self.submit.titleText = String(localized: "auth.reset.done", bundle: .lody)
      } catch {
        guard let self, self.generation == id, !Task.isCancelled else { return }
        self.message.text = (error as? AuthFailure)?.message ?? String(localized: "auth.reset.failed", bundle: .lody)
        self.message.textColor = LoginPalette.danger
      }
      guard let self, self.generation == id else { return }
      self.task = nil
      self.setBusy(false)
    }
  }

  private func setBusy(_ busy: Bool) {
    submit.isEnabled = !busy
    email.isEnabled = !busy
    submit.setWorking(busy)
  }

  private func show(_ key: String, error: Bool = false) {
    message.text = String(localized: String.LocalizationValue(key), bundle: .lody)
    message.textColor = error ? LoginPalette.danger : LoginPalette.secondaryLabel
  }
}
