import AuthenticationServices
import UIKit

@MainActor
class OnboardingController: UIViewController, UITextFieldDelegate {
  private let service: OnboardingService
  private let scroll = UIScrollView()
  private let email = UITextField()
  private let name = UITextField()
  private var registering = false
  private var emailSubmit: UIButton?
  private let password = UITextField()
  private let errorLabel = UILabel()
  private let progress = UIActivityIndicatorView(style: .medium)
  private let cancelButton = UIButton(type: .system)
  private var controls: [UIControl] = []
  private var observers: [NSObjectProtocol] = []
  private var finished = false

  init(service: OnboardingService = .live) {
    self.service = service
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "onboarding.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
  isolated deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    view.accessibilityIdentifier = "onboarding-sheet"
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
      stack.centerXAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerXAnchor),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
    ])
    let heading = UILabel()
    heading.text = String(localized: "auth.native.title", bundle: .lody)
    heading.font = .preferredFont(forTextStyle: .largeTitle)
    heading.adjustsFontForContentSizeCategory = true
    heading.accessibilityTraits = .header
    heading.numberOfLines = 0
    stack.addArrangedSubview(heading)
    configure(name, key: "auth.native.name", content: .name)
    name.autocapitalizationType = .words
    name.isHidden = true
    stack.addArrangedSubview(name)
    configure(email, key: "auth.native.email", content: .username)
    email.keyboardType = .emailAddress
    email.returnKeyType = .next
    configure(password, key: "auth.native.password", content: .password)
    password.isSecureTextEntry = true
    password.returnKeyType = .go
    stack.addArrangedSubview(email)
    stack.addArrangedSubview(password)
    let signIn = button("auth.native.signIn") { [weak self] in self?.submitEmail() }
    emailSubmit = signIn
    signIn.accessibilityIdentifier = "auth-email-submit"
    stack.addArrangedSubview(signIn)
    let toggle = button("auth.native.toggleRegistration") { [weak self] in
      guard let self else { return }
      self.registering.toggle()
      self.name.isHidden = !self.registering
      self.password.text = nil
      self.password.textContentType = self.registering ? .newPassword : .password
      let key = self.registering ? "auth.native.register" : "auth.native.signIn"
      self.emailSubmit?.configuration?.title = String(localized: String.LocalizationValue(key), bundle: .lody)
    }
    toggle.accessibilityIdentifier = "auth-registration-toggle"
    stack.addArrangedSubview(toggle)
    let resend = button("auth.native.resend") { [weak self] in
      guard let self else { return }
      let address = (self.email.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard address.contains("@") else {
        self.errorLabel.text = String(localized: "auth.native.fields", bundle: .lody)
        self.errorLabel.isHidden = false
        return
      }
      self.password.text = nil
      self.submit(.resendVerification(address))
    }
    resend.accessibilityIdentifier = "auth-verification-resend"
    stack.addArrangedSubview(resend)
    let reset = button("auth.reset.forgot") { [weak self] in
      guard let self, !self.service.state().busy else { return }
      self.password.text = nil
      self.view.endEditing(true)
      let page = PasswordResetController()
      LodyShell.shared.presentNative(page, title: page.title ?? "")
    }
    reset.accessibilityIdentifier = "auth-reset-request"
    stack.addArrangedSubview(reset)
    let apple = ASAuthorizationAppleIDButton(type: .signIn, style: .black)
    apple.addAction(UIAction { [weak self] _ in self?.submit(.apple) }, for: .touchUpInside)
    apple.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
    apple.accessibilityIdentifier = "auth-apple"
    controls.append(apple)
    stack.addArrangedSubview(apple)
    for (key, method) in [("auth.native.google", NativeLoginMethod.google), ("auth.native.github", .github), ("auth.native.discord", .discord)] {
      let control = button(key) { [weak self] in self?.submit(method) }
      control.accessibilityIdentifier = key
      stack.addArrangedSubview(control)
    }
    errorLabel.numberOfLines = 0
    errorLabel.font = .preferredFont(forTextStyle: .body)
    errorLabel.adjustsFontForContentSizeCategory = true
    errorLabel.textColor = .systemRed
    errorLabel.accessibilityIdentifier = "auth-error"
    stack.addArrangedSubview(errorLabel)
    stack.addArrangedSubview(progress)
    cancelButton.setTitle(String(localized: "common.cancel", bundle: .lody), for: .normal)
    cancelButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    cancelButton.addAction(UIAction { [weak self] _ in self?.service.cancel() }, for: .touchUpInside)
    cancelButton.accessibilityIdentifier = "auth-cancel"
    stack.addArrangedSubview(cancelButton)
    for name in service.changes {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      })
    }
    render()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    LodyScrollEdges.bind(scroll, to: self)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isMovingFromParent || navigationController?.isBeingDismissed == true || isBeingDismissed {
      service.cancel()
      password.text = nil
    }
  }

  private func configure(_ field: UITextField, key: String, content: UITextContentType) {
    field.placeholder = String(localized: String.LocalizationValue(key), bundle: .lody)
    field.accessibilityLabel = field.placeholder
    field.accessibilityIdentifier = key
    field.textContentType = content
    field.autocapitalizationType = .none
    field.autocorrectionType = .no
    field.borderStyle = .roundedRect
    field.font = .preferredFont(forTextStyle: .body)
    field.adjustsFontForContentSizeCategory = true
    field.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
    field.delegate = self
    controls.append(field)
  }

  private func button(_ key: String, action: @escaping @MainActor () -> Void) -> UIButton {
    var config = UIButton.Configuration.filled()
    config.title = String(localized: String.LocalizationValue(key), bundle: .lody)
    config.baseBackgroundColor = .systemBlue
    let button = UIButton(configuration: config)
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
    button.addAction(UIAction { _ in action() }, for: .touchUpInside)
    controls.append(button)
    return button
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    if textField === email { password.becomeFirstResponder() }
    else { submitEmail() }
    return true
  }

  private func submitEmail() {
    let address = (email.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard address.contains("@"), let secret = password.text, !secret.isEmpty else {
      errorLabel.text = String(localized: "auth.native.fields", bundle: .lody)
      errorLabel.isHidden = false
      return
    }
    if registering {
      let displayName = (name.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !displayName.isEmpty, (8...128).contains(secret.count) else {
        errorLabel.text = String(localized: "auth.native.registrationFields", bundle: .lody)
        errorLabel.isHidden = false
        return
      }
      submit(.register(displayName, address, secret))
    } else { submit(.email(address, secret)) }
    password.text = nil
  }

  private func submit(_ method: NativeLoginMethod) {
    guard !service.state().busy else { return }
    view.endEditing(true)
    service.login(method)
  }

  private func render() {
    let state = service.state()
    if state.signedIn {
      guard !finished else { return }
      finished = true
      password.text = nil
      LodyShell.shared.finish(from: self, value: nil)
      LodyShell.shared.close(from: self)
      return
    }
    controls.forEach { $0.isEnabled = !state.busy }
    cancelButton.isHidden = !state.busy
    if state.busy { progress.startAnimating() } else { progress.stopAnimating() }
    errorLabel.isHidden = state.error == nil
    if let error = state.error, errorLabel.text != error { UIAccessibility.post(notification: .announcement, argument: error) }
    errorLabel.text = state.error
  }
}
