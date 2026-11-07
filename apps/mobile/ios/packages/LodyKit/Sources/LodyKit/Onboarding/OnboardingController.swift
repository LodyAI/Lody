import UIKit

/// Native sign-in, laid out as web `/login` (`login-page.tsx`): the dithered
/// jellyfish surface on top, then a bottom-anchored column with the title, one
/// group of equal provider buttons, the email entry and the legal notice. The
/// email view slides in beside the providers and folds the visual away.
@MainActor
class OnboardingController: UIViewController, UITextFieldDelegate {
  private enum Screen { case providers, email }
  private enum Mode { case signIn, signUp }

  private static let transition = (duration: 0.32, from: CGPoint(x: 0.4, y: 0), to: CGPoint(x: 0.2, y: 1))

  private let service: OnboardingService
  private let lastUsed = NativeLastLoginMethod.read()
  private var screen = Screen.providers
  private var mode = Mode.signIn
  /// The method this page started, so its row reads "Authenticating...".
  private var started: NativeLastLoginMethod?
  /// Local validation, shown until the next edit or attempt.
  private var validation: String?
  private var observers: [NSObjectProtocol] = []
  private var finished = false
  private var animator: UIViewPropertyAnimator?

  private let visual = LoginDitherView()
  private var visualHeight: NSLayoutConstraint?
  private var visualMinimumHeight: NSLayoutConstraint?
  private var visualTop: NSLayoutConstraint?
  private let scroll = UIScrollView()
  private var columnBottom: NSLayoutConstraint?

  private let backRow = UIView()
  private let titleLabel = UILabel()
  private let descriptionLabel = UILabel()
  private let errorBox = UIView()
  private let errorLabel = UILabel()
  private let slot = UIView()
  private let providersPanel = UIStackView()
  private let emailPanel = UIView()
  private var slotBottoms: [Screen: NSLayoutConstraint] = [:]
  private let formPanel = UIStackView()
  private let verificationPanel = UIStackView()
  private let legal = UITextView()
  private let legalRule = UIView()

  private var providerButtons: [(NativeLastLoginMethod, LoginButton)] = []
  private var emailEntry: LoginButton!
  private let cancelButton = LoginButton(.ghost, title: String(localized: "common.cancel", bundle: .lody), centered: true)
  private let nameRow = UIView()
  private let nameField = LoginField(label: String(localized: "auth.login.nameLabel", bundle: .lody))
  private let emailField = LoginField(label: String(localized: "auth.login.emailLabel", bundle: .lody))
  private let passwordField = LoginField(label: String(localized: "auth.login.passwordLabel", bundle: .lody))
  private let revealButton = UIButton(type: .system)
  private let forgotRow = UIView()
  private let submit = LoginButton(.primary, title: String(localized: "auth.login.signIn", bundle: .lody), centered: true)
  private let submitArrow = UIImageView(image: UIImage(systemName: "arrow.right",
                                                       withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .medium)))
  private var resendInline: UIButton!
  private var modeToggle: UIButton!
  private let verificationBody = UILabel()
  private var controls: [UIControl] = []

  private var name: UITextField { nameField.field }
  private var email: UITextField { emailField.field }
  private var password: UITextField { passwordField.field }

  init(service: OnboardingService = .live) {
    self.service = service
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "auth.login.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
  isolated deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = LoginPalette.page
    view.accessibilityIdentifier = "onboarding-sheet"
    buildLayout()
    buildHeader()
    buildProviders()
    buildEmailForm()
    buildVerification()
    buildLegal()
    for name in service.changes {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      })
    }
    show(.providers, animated: false)
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

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    layoutVisual()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    // Web pads the page by max(12, safe area) and the column by 12 more.
    columnBottom?.constant = view.safeAreaInsets.bottom > 0 ? -12 : -24
    visualTop?.constant = max(12, view.safeAreaInsets.top)
  }

  // MARK: Layout

  private func buildLayout() {
    visual.translatesAutoresizingMaskIntoConstraints = false
    visual.layer.cornerRadius = 14
    visual.layer.cornerCurve = .continuous
    view.addSubview(visual)
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.keyboardDismissMode = .interactive
    scroll.alwaysBounceVertical = false
    scroll.showsVerticalScrollIndicator = false
    view.addSubview(scroll)
    let column = UIStackView(arrangedSubviews: [header, errorBox, slot, legalBlock])
    column.axis = .vertical
    column.spacing = 24
    column.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(column)
    let top = visual.topAnchor.constraint(equalTo: view.topAnchor, constant: 12)
    let height = visual.heightAnchor.constraint(equalToConstant: 0)
    // Prefer web's 42vh / 360 pt surface, but reserve room for the native
    // 44 pt controls and legal notice before allowing the column to scroll.
    height.priority = UILayoutPriority(249)
    let minimumHeight = visual.heightAnchor.constraint(greaterThanOrEqualToConstant: 0)
    minimumHeight.priority = UILayoutPriority(251)
    let bottom = column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -12)
    let fill = scroll.contentLayoutGuide.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor)
    fill.priority = .defaultLow
    visualTop = top
    visualHeight = height
    visualMinimumHeight = minimumHeight
    columnBottom = bottom
    NSLayoutConstraint.activate([
      top, height, minimumHeight,
      visual.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
      visual.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      scroll.topAnchor.constraint(equalTo: visual.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      scroll.contentLayoutGuide.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
      scroll.contentLayoutGuide.heightAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.heightAnchor),
      fill,
      // The sign-in group sits at the bottom, within reach of a thumb.
      column.topAnchor.constraint(greaterThanOrEqualTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
      bottom,
      column.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 32),
      column.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -32),
    ])
    errorBox.isHidden = true
  }

  /// Web: `clamp(200px, 42svh, 360px)`, folded away in the email view and absent
  /// when a phone on its side leaves no room above the form. The preferred
  /// height yields toward 200 pt to keep native controls and legal copy visible.
  private func layoutVisual() {
    let bounds = view.bounds.height
    let folded = screen == .email || (bounds < 600 && traitCollection.verticalSizeClass == .compact)
    let target: CGFloat = folded ? 0 : min(360, max(200, bounds * 0.42))
    if visualHeight?.constant != target { visualHeight?.constant = target }
    visualMinimumHeight?.constant = folded ? 0 : 200
    visual.alpha = folded ? 0 : 1
  }

  private lazy var header: UIView = {
    let stack = UIStackView(arrangedSubviews: [backRow, titleLabel, descriptionLabel])
    stack.axis = .vertical
    stack.alignment = .fill
    stack.setCustomSpacing(8, after: backRow)
    stack.setCustomSpacing(8, after: titleLabel)
    return stack
  }()

  private lazy var legalBlock: UIView = {
    let block = UIView()
    legalRule.backgroundColor = LoginPalette.separator
    legalRule.translatesAutoresizingMaskIntoConstraints = false
    legal.translatesAutoresizingMaskIntoConstraints = false
    block.addSubview(legalRule)
    block.addSubview(legal)
    NSLayoutConstraint.activate([
      legalRule.topAnchor.constraint(equalTo: block.topAnchor),
      legalRule.leadingAnchor.constraint(equalTo: block.leadingAnchor),
      legalRule.trailingAnchor.constraint(equalTo: block.trailingAnchor),
      legalRule.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
      legal.topAnchor.constraint(equalTo: legalRule.bottomAnchor, constant: 16),
      legal.leadingAnchor.constraint(equalTo: block.leadingAnchor),
      legal.trailingAnchor.constraint(equalTo: block.trailingAnchor),
      legal.bottomAnchor.constraint(equalTo: block.bottomAnchor),
    ])
    return block
  }()

  private func buildHeader() {
    let back = LoginButton(.ghost, title: String(localized: "auth.login.back", bundle: .lody),
                           image: UIImage(systemName: "arrow.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .medium)))
    back.accessibilityIdentifier = "auth-email-back"
    back.addAction(UIAction { [weak self] _ in self?.leaveEmail() }, for: .touchUpInside)
    controls.append(back)
    backRow.addSubview(back)
    NSLayoutConstraint.activate([
      back.topAnchor.constraint(equalTo: backRow.topAnchor),
      back.bottomAnchor.constraint(equalTo: backRow.bottomAnchor),
      // Web pulls the ghost button out by its padding so the arrow meets the edge.
      back.leadingAnchor.constraint(equalTo: backRow.leadingAnchor, constant: -14),
    ])
    titleLabel.font = LoginType.title
    titleLabel.adjustsFontForContentSizeCategory = true
    titleLabel.textColor = LoginPalette.label
    titleLabel.numberOfLines = 0
    titleLabel.accessibilityTraits = .header
    titleLabel.attributedText = nil
    descriptionLabel.font = LoginType.description
    descriptionLabel.adjustsFontForContentSizeCategory = true
    descriptionLabel.textColor = LoginPalette.secondaryLabel
    descriptionLabel.numberOfLines = 0
    errorBox.backgroundColor = LoginPalette.dangerFill
    errorBox.layer.cornerRadius = 8
    errorBox.layer.cornerCurve = .continuous
    errorBox.layer.borderWidth = 1
    errorBox.layer.borderColor = LoginPalette.dangerEdge.cgColor
    errorLabel.font = LoginType.small
    errorLabel.adjustsFontForContentSizeCategory = true
    errorLabel.textColor = LoginPalette.danger
    errorLabel.numberOfLines = 0
    errorLabel.accessibilityIdentifier = "auth-error"
    errorLabel.translatesAutoresizingMaskIntoConstraints = false
    errorBox.addSubview(errorLabel)
    NSLayoutConstraint.activate([
      errorLabel.topAnchor.constraint(equalTo: errorBox.topAnchor, constant: 8),
      errorLabel.bottomAnchor.constraint(equalTo: errorBox.bottomAnchor, constant: -8),
      errorLabel.leadingAnchor.constraint(equalTo: errorBox.leadingAnchor, constant: 12),
      errorLabel.trailingAnchor.constraint(equalTo: errorBox.trailingAnchor, constant: -12),
    ])
  }

  // MARK: Providers

  private func buildProviders() {
    let group = UIStackView()
    group.axis = .vertical
    group.spacing = 8
    let marks: [(NativeLastLoginMethod, NativeLoginMethod, String, String, UIImage?)] = [
      (.github, .github, String(localized: "auth.login.github", bundle: .lody), "auth.native.github", UIImage(named: "lody-login-github")),
      (.google, .google, String(localized: "auth.login.google", bundle: .lody), "auth.native.google", UIImage(named: "lody-login-google")),
      (.apple, .apple, String(localized: "auth.login.apple", bundle: .lody), "auth-apple",
       UIImage(systemName: "apple.logo", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))),
      (.discord, .discord, String(localized: "auth.login.discord", bundle: .lody), "auth.native.discord", UIImage(named: "lody-login-discord")),
    ]
    for (kind, method, label, identifier, image) in marks {
      // One group of equal buttons: a provider is a choice, not a recommendation.
      let button = LoginButton(.secondary, title: label, image: image?.withRenderingMode(.alwaysTemplate))
      button.accessibilityIdentifier = identifier
      button.addAction(UIAction { [weak self] _ in self?.submit(method) }, for: .touchUpInside)
      controls.append(button)
      providerButtons.append((kind, button))
      group.addArrangedSubview(button)
    }
    let entry = LoginButton(.ghost, title: String(localized: "auth.login.email", bundle: .lody),
                            image: UIImage(systemName: "envelope", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .regular)))
    entry.accessibilityIdentifier = "auth-email-entry"
    entry.addAction(UIAction { [weak self] _ in self?.enterEmail() }, for: .touchUpInside)
    controls.append(entry)
    emailEntry = entry
    for (kind, button) in providerButtons + [(.email, entry)] where kind == lastUsed {
      button.setTrailing(LoginBadge(String(localized: "auth.login.lastUsed", bundle: .lody)))
      button.accessibilityLabel = "\(button.titleText), \(String(localized: "auth.login.lastUsed", bundle: .lody))"
    }
    cancelButton.accessibilityIdentifier = "auth-cancel"
    cancelButton.addAction(UIAction { [weak self] _ in self?.service.cancel() }, for: .touchUpInside)
    providersPanel.axis = .vertical
    providersPanel.spacing = 12
    [group, entry, cancelButton].forEach(providersPanel.addArrangedSubview)
    install(providersPanel, for: .providers)
  }

  private func install(_ panel: UIView, for screen: Screen) {
    panel.translatesAutoresizingMaskIntoConstraints = false
    slot.addSubview(panel)
    NSLayoutConstraint.activate([
      panel.topAnchor.constraint(equalTo: slot.topAnchor),
      panel.leadingAnchor.constraint(equalTo: slot.leadingAnchor),
      panel.trailingAnchor.constraint(equalTo: slot.trailingAnchor),
    ])
    slotBottoms[screen] = panel.bottomAnchor.constraint(equalTo: slot.bottomAnchor)
  }

  // MARK: Email

  private func buildEmailForm() {
    configure(name, placeholder: String(localized: "auth.login.namePlaceholder", bundle: .lody), identifier: "auth.native.name", content: .name)
    name.autocapitalizationType = .words
    name.returnKeyType = .next
    configure(email, placeholder: String(localized: "auth.login.emailPlaceholder", bundle: .lody), identifier: "auth.native.email", content: .username)
    email.keyboardType = .emailAddress
    email.returnKeyType = .next
    configure(password, placeholder: String(localized: "auth.login.passwordPlaceholder", bundle: .lody), identifier: "auth.native.password", content: .password)
    password.isSecureTextEntry = true
    password.returnKeyType = .go
    revealButton.tintColor = LoginPalette.secondaryLabel
    revealButton.accessibilityIdentifier = "auth-password-reveal"
    revealButton.addAction(UIAction { [weak self] _ in self?.togglePasswordReveal() }, for: .touchUpInside)
    password.rightView = revealButton
    password.rightViewMode = .always
    paintReveal()

    nameField.translatesAutoresizingMaskIntoConstraints = false
    nameRow.addSubview(nameField)
    NSLayoutConstraint.activate([
      nameField.topAnchor.constraint(equalTo: nameRow.topAnchor),
      nameField.leadingAnchor.constraint(equalTo: nameRow.leadingAnchor),
      nameField.trailingAnchor.constraint(equalTo: nameRow.trailingAnchor),
      nameField.bottomAnchor.constraint(equalTo: nameRow.bottomAnchor, constant: -12),
    ])
    nameRow.clipsToBounds = true

    let forgot = loginTextButton(String(localized: "auth.login.forgotPassword", bundle: .lody), strong: false) { [weak self] in
      self?.forgotPassword()
    }
    forgot.accessibilityIdentifier = "auth-reset-request"
    forgot.translatesAutoresizingMaskIntoConstraints = false
    controls.append(forgot)
    forgotRow.addSubview(forgot)
    NSLayoutConstraint.activate([
      forgot.topAnchor.constraint(equalTo: forgotRow.topAnchor, constant: -4),
      forgot.bottomAnchor.constraint(equalTo: forgotRow.bottomAnchor, constant: -4),
      forgot.trailingAnchor.constraint(equalTo: forgotRow.trailingAnchor, constant: 4),
    ])

    submit.accessibilityIdentifier = "auth-email-submit"
    submit.addAction(UIAction { [weak self] _ in self?.submitEmail() }, for: .touchUpInside)
    controls.append(submit)

    let resend = loginTextButton(String(localized: "auth.login.resendVerification", bundle: .lody), strong: false) { [weak self] in
      self?.resendVerification()
    }
    resend.accessibilityIdentifier = "auth-verification-resend"
    controls.append(resend)
    resendInline = resend

    let toggle = UIButton(configuration: .plain())
    toggle.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    toggle.accessibilityIdentifier = "auth-registration-toggle"
    toggle.addAction(UIAction { [weak self] _ in self?.toggleMode() }, for: .touchUpInside)
    controls.append(toggle)
    modeToggle = toggle

    formPanel.axis = .vertical
    formPanel.alignment = .fill
    [nameRow, emailField, passwordField, forgotRow, submit, resend, toggle].forEach(formPanel.addArrangedSubview)
    formPanel.setCustomSpacing(12, after: emailField)
    formPanel.setCustomSpacing(4, after: passwordField)
    formPanel.setCustomSpacing(8, after: forgotRow)
    formPanel.setCustomSpacing(4, after: submit)
    formPanel.setCustomSpacing(8, after: resend)

    verificationPanel.isHidden = true
    [formPanel, verificationPanel].forEach { panel in
      panel.translatesAutoresizingMaskIntoConstraints = false
      emailPanel.addSubview(panel)
    }
    NSLayoutConstraint.activate([
      formPanel.topAnchor.constraint(equalTo: emailPanel.topAnchor),
      formPanel.leadingAnchor.constraint(equalTo: emailPanel.leadingAnchor),
      formPanel.trailingAnchor.constraint(equalTo: emailPanel.trailingAnchor),
      verificationPanel.topAnchor.constraint(equalTo: emailPanel.topAnchor),
      verificationPanel.leadingAnchor.constraint(equalTo: emailPanel.leadingAnchor),
      verificationPanel.trailingAnchor.constraint(equalTo: emailPanel.trailingAnchor),
    ])
    emailPanelBottoms = (
      form: formPanel.bottomAnchor.constraint(equalTo: emailPanel.bottomAnchor),
      verification: verificationPanel.bottomAnchor.constraint(equalTo: emailPanel.bottomAnchor)
    )
    emailPanelBottoms?.form.isActive = true
    install(emailPanel, for: .email)
    applyMode()
  }

  private var emailPanelBottoms: (form: NSLayoutConstraint, verification: NSLayoutConstraint)?

  private func buildVerification() {
    let circle = UIView()
    circle.backgroundColor = LoginPalette.mutedCircle
    circle.layer.cornerRadius = 24
    let mail = UIImageView(image: UIImage(systemName: "envelope", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .regular)))
    mail.tintColor = LoginPalette.label
    mail.translatesAutoresizingMaskIntoConstraints = false
    circle.addSubview(mail)
    circle.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      circle.widthAnchor.constraint(equalToConstant: 48), circle.heightAnchor.constraint(equalToConstant: 48),
      mail.centerXAnchor.constraint(equalTo: circle.centerXAnchor), mail.centerYAnchor.constraint(equalTo: circle.centerYAnchor),
    ])
    verificationBody.numberOfLines = 0
    verificationBody.textAlignment = .center
    verificationBody.adjustsFontForContentSizeCategory = true
    verificationBody.accessibilityIdentifier = "auth-verification-body"

    let resendLine = UIStackView()
    resendLine.axis = .horizontal
    resendLine.alignment = .center
    resendLine.spacing = 0
    let prompt = UILabel()
    prompt.text = String(localized: "auth.login.newEmailAccount", bundle: .lody)
    prompt.font = LoginType.small
    prompt.adjustsFontForContentSizeCategory = true
    prompt.textColor = LoginPalette.secondaryLabel
    let resend = loginTextButton(String(localized: "auth.login.resend", bundle: .lody), strong: true) { [weak self] in
      self?.resendVerification()
    }
    resend.accessibilityIdentifier = "auth-verification-panel-resend"
    controls.append(resend)
    [prompt, resend].forEach(resendLine.addArrangedSubview)
    let reset = loginTextButton(String(localized: "auth.login.setPassword", bundle: .lody), strong: true) { [weak self] in
      self?.forgotPassword()
    }
    reset.accessibilityIdentifier = "auth-verification-reset"
    controls.append(reset)
    let rule = UIView()
    rule.backgroundColor = LoginPalette.separator
    rule.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([rule.widthAnchor.constraint(equalToConstant: 32), rule.heightAnchor.constraint(equalToConstant: 1)])
    let back = loginTextButton(String(localized: "auth.login.backToOptions", bundle: .lody), strong: false) { [weak self] in
      self?.leaveEmail()
    }
    back.accessibilityIdentifier = "auth-verification-back"
    controls.append(back)
    verificationPanel.axis = .vertical
    verificationPanel.alignment = .center
    verificationPanel.spacing = 0
    [circle, verificationBody, resendLine, reset, rule, back].forEach(verificationPanel.addArrangedSubview)
    verificationPanel.setCustomSpacing(12, after: circle)
    verificationPanel.setCustomSpacing(16, after: verificationBody)
    verificationPanel.setCustomSpacing(4, after: reset)
    verificationPanel.setCustomSpacing(4, after: rule)
    verificationBody.widthAnchor.constraint(equalTo: verificationPanel.widthAnchor).isActive = true
  }

  private func buildLegal() {
    legal.isEditable = false
    legal.isScrollEnabled = false
    legal.backgroundColor = .clear
    legal.textContainerInset = .zero
    legal.textContainer.lineFragmentPadding = 0
    legal.adjustsFontForContentSizeCategory = true
    legal.linkTextAttributes = [
      .foregroundColor: LoginPalette.secondaryLabel,
      .underlineStyle: NSUnderlineStyle.single.rawValue,
      .underlineColor: LoginPalette.secondaryLabel,
    ]
    let chinese = Bundle.lody.preferredLocalizations.first?.hasPrefix("zh") == true
    let terms = String(localized: "auth.login.terms", bundle: .lody)
    let privacy = String(localized: "auth.login.privacy", bundle: .lody)
    let text = String.localizedStringWithFormat(String(localized: "auth.login.legal", bundle: .lody), terms, privacy)
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = 1.25
    let attributed = NSMutableAttributedString(string: text, attributes: [
      .font: LoginType.legal, .foregroundColor: LoginPalette.tertiaryLabel, .paragraphStyle: paragraph,
    ])
    for (word, path) in [(terms, chinese ? "/zh/terms" : "/terms"), (privacy, chinese ? "/zh/privacy" : "/privacy")] {
      let range = (text as NSString).range(of: word)
      if range.location != NSNotFound, let url = URL(string: "https://lody.ai" + path) {
        attributed.addAttribute(.link, value: url, range: range)
      }
    }
    legal.attributedText = attributed
    legal.accessibilityIdentifier = "auth-legal"
  }

  private func configure(_ field: UITextField, placeholder: String, identifier: String, content: UITextContentType) {
    field.placeholder = placeholder
    field.accessibilityIdentifier = identifier
    field.textContentType = content
    field.delegate = self
    field.addAction(UIAction { [weak self] _ in self?.edited() }, for: .editingChanged)
    controls.append(field)
  }

  // MARK: Actions

  private func enterEmail() {
    guard !service.state().busy else { return }
    validation = nil
    show(.email, animated: true)
  }

  private func leaveEmail() {
    guard !service.state().busy else { return }
    view.endEditing(true)
    validation = nil
    password.text = nil
    acknowledgedVerification = true
    show(.providers, animated: true)
  }

  private func toggleMode() {
    mode = mode == .signIn ? .signUp : .signIn
    password.text = nil
    validation = nil
    applyMode()
    render()
    UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.32) { self.view.layoutIfNeeded() }
  }

  private func togglePasswordReveal() {
    password.isSecureTextEntry.toggle()
    paintReveal()
  }

  private func paintReveal() {
    let hidden = password.isSecureTextEntry
    revealButton.setImage(UIImage(systemName: hidden ? "eye" : "eye.slash",
                                  withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .regular)), for: .normal)
    revealButton.accessibilityLabel = hidden
      ? String(localized: "auth.login.showPassword", bundle: .lody)
      : String(localized: "auth.login.hidePassword", bundle: .lody)
  }

  private func forgotPassword() {
    guard !service.state().busy else { return }
    password.text = nil
    view.endEditing(true)
    let page = PasswordResetController(email: trimmedEmail)
    LodyShell.shared.presentNative(page, title: page.title ?? "")
  }

  private func resendVerification() {
    let address = trimmedEmail
    guard Self.isEmail(address) else {
      fail(String(localized: "auth.login.emailInvalid", bundle: .lody))
      return
    }
    password.text = nil
    submit(.resendVerification(address))
  }

  private func edited() {
    guard validation != nil else { return }
    validation = nil
    render()
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    if textField === name { email.becomeFirstResponder() }
    else if textField === email { password.becomeFirstResponder() }
    else { submitEmail() }
    return true
  }

  private var trimmedEmail: String { (email.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

  private static func isEmail(_ value: String) -> Bool {
    let parts = value.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, value.count <= 254 else { return false }
    let domain = parts[1]
    return domain.contains(".") && !domain.hasPrefix(".") && !domain.hasSuffix(".") && !value.contains(where: \.isWhitespace)
  }

  private func submitEmail() {
    let address = trimmedEmail
    let secret = password.text ?? ""
    guard Self.isEmail(address) else { return fail(String(localized: "auth.login.emailInvalid", bundle: .lody)) }
    guard !secret.isEmpty else { return fail(String(localized: "auth.login.passwordEmpty", bundle: .lody)) }
    if mode == .signUp {
      let displayName = (name.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !displayName.isEmpty else { return fail(String(localized: "auth.login.nameRequired", bundle: .lody)) }
      // Web `validateNewPassword`, plus the backend's 128-character ceiling.
      guard secret.count >= 8 else { return fail(String(localized: "auth.login.passwordTooShort", bundle: .lody)) }
      guard secret.count <= 128 else { return fail(String(localized: "auth.login.passwordTooLong", bundle: .lody)) }
      guard secret.contains(where: { $0.isASCII && $0.isLetter }), secret.contains(where: { $0.isASCII && $0.isNumber }) else {
        return fail(String(localized: "auth.login.passwordComplexity", bundle: .lody))
      }
      submit(.register(displayName, address.lowercased(), secret))
    } else {
      submit(.email(address.lowercased(), secret))
    }
    password.text = nil
  }

  private func fail(_ message: String) {
    validation = message
    render()
  }

  private func submit(_ method: NativeLoginMethod) {
    guard !service.state().busy else { return }
    view.endEditing(true)
    validation = nil
    started = NativeLastLoginMethod(method)
    acknowledgedVerification = false
    if case let .resendVerification(address) = method { verificationAddress = address }
    if case let .register(_, address, _) = method { verificationAddress = address }
    service.login(method)
  }

  /// The address a verification link went to, shown in "Next steps".
  private var verificationAddress = ""
  /// Leaving the email view dismisses "Next steps" until the next attempt.
  private var acknowledgedVerification = false

  // MARK: Rendering

  private func show(_ next: Screen, animated: Bool) {
    let previous = screen
    screen = next
    let incoming = next == .providers ? providersPanel : emailPanel
    let outgoing = next == .providers ? emailPanel : providersPanel
    slotBottoms.values.forEach { $0.isActive = false }
    slotBottoms[next]?.isActive = true
    render()
    let moving = animated && previous != next && !UIAccessibility.isReduceMotionEnabled && view.window != nil
    guard moving else {
      incoming.isHidden = false
      incoming.transform = .identity
      outgoing.isHidden = true
      view.setNeedsLayout()
      if next == .email, animated { email.becomeFirstResponder() }
      return
    }
    // Both panels slide together, as web's `LoginViewSlot`: the email view comes
    // in from the trailing side and the visual folds away in the same motion.
    animator?.stopAnimation(true)
    let distance = (slot.bounds.width + 32) * (next == .email ? 1 : -1)
    let direction: CGFloat = view.effectiveUserInterfaceLayoutDirection == .rightToLeft ? -1 : 1
    incoming.isHidden = false
    incoming.transform = CGAffineTransform(translationX: distance * direction, y: 0)
    let animator = UIViewPropertyAnimator(duration: Self.transition.duration, controlPoint1: Self.transition.from,
                                          controlPoint2: Self.transition.to) { [weak self] in
      guard let self else { return }
      outgoing.transform = CGAffineTransform(translationX: -distance * direction, y: 0)
      incoming.transform = .identity
      self.layoutVisual()
      self.view.layoutIfNeeded()
    }
    animator.addCompletion { [weak self] _ in
      guard let self, self.screen == next else { return }
      outgoing.isHidden = true
      outgoing.transform = .identity
      if next == .email { self.email.becomeFirstResponder() }
    }
    self.animator = animator
    animator.startAnimation()
  }

  private func applyMode() {
    let signUp = mode == .signUp
    nameRow.isHidden = !signUp
    forgotRow.isHidden = signUp
    // Web: the password field keeps 12 pt below it and the submit button adds 4 more;
    // signing in, the forgot-password row sits in that gap instead.
    formPanel.setCustomSpacing(signUp ? 16 : 4, after: passwordField)
    password.textContentType = signUp ? .newPassword : .password
    password.placeholder = signUp
      ? String(localized: "auth.login.passwordCreatePlaceholder", bundle: .lody)
      : String(localized: "auth.login.passwordPlaceholder", bundle: .lody)
    let prompt = signUp ? String(localized: "auth.login.haveAccount", bundle: .lody) : String(localized: "auth.login.noAccount", bundle: .lody)
    let action = signUp ? String(localized: "auth.login.signInLink", bundle: .lody) : String(localized: "auth.login.createAccount", bundle: .lody)
    var title = AttributedString(prompt + " ", attributes: AttributeContainer([.font: LoginType.small, .foregroundColor: LoginPalette.secondaryLabel]))
    title += AttributedString(action, attributes: AttributeContainer([.font: LoginType.smallStrong, .foregroundColor: LoginPalette.label]))
    modeToggle.configuration?.attributedTitle = title
    modeToggle.accessibilityLabel = "\(prompt) \(action)"
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
    if !state.busy { started = nil }
    let verifying = screen == .email && state.verificationSent && !acknowledgedVerification
    let signUp = mode == .signUp

    // Header copy follows the view, as web's `headerTitle` / `headerDescription`.
    let heading: String
    let detail: String
    switch (screen, verifying, signUp) {
    case (.providers, _, _):
      heading = String(localized: "auth.login.title", bundle: .lody)
      detail = String(localized: "auth.login.description", bundle: .lody)
    case (.email, true, _):
      heading = String(localized: "auth.login.verificationTitle", bundle: .lody)
      detail = ""
    case (.email, false, true):
      heading = String(localized: "auth.login.createTitle", bundle: .lody)
      detail = String(localized: "auth.login.createDescription", bundle: .lody)
    case (.email, false, false):
      heading = String(localized: "auth.login.emailTitle", bundle: .lody)
      detail = String(localized: "auth.login.emailDescription", bundle: .lody)
    }
    if titleLabel.text != heading || descriptionLabel.text != detail {
      let apply = {
        self.titleLabel.attributedText = NSAttributedString(string: heading, attributes: [.kern: -0.7])
        self.descriptionLabel.text = detail
        self.descriptionLabel.isHidden = detail.isEmpty
      }
      if titleLabel.text == nil || view.window == nil { apply() }
      else { UIView.transition(with: header, duration: 0.2, options: [.transitionCrossDissolve, .allowUserInteraction], animations: apply) }
    }
    backRow.isHidden = screen != .email
    legalRule.superview?.isHidden = verifying

    formPanel.isHidden = verifying
    verificationPanel.isHidden = !verifying
    emailPanelBottoms?.form.isActive = !verifying
    emailPanelBottoms?.verification.isActive = verifying
    if verifying { paintVerificationBody() }

    controls.forEach { $0.isEnabled = !state.busy }
    for (kind, button) in providerButtons {
      button.titleText = started == kind && state.busy
        ? String(localized: "auth.login.loading", bundle: .lody)
        : providerTitle(kind)
    }
    cancelButton.isHidden = !state.busy || started == .email
    submit.setWorking(state.busy && started == .email)
    if state.busy, started == .email {
      submit.titleText = signUp ? String(localized: "auth.login.creatingAccount", bundle: .lody) : String(localized: "auth.login.loading", bundle: .lody)
      submit.setTrailing(nil)
    } else {
      submit.titleText = signUp ? String(localized: "auth.login.createAccount", bundle: .lody) : String(localized: "auth.login.signIn", bundle: .lody)
      if submitArrow.superview == nil { submit.setTrailing(submitArrow) }
    }

    let message = validation ?? state.error
    // Web offers the resend link after an email sign-in that could not finish,
    // which is how an unverified address first shows up.
    resendInline.isHidden = signUp || state.error == nil || validation != nil
    errorBox.isHidden = message == nil
    if let message, errorLabel.text != message { UIAccessibility.post(notification: .announcement, argument: message) }
    errorLabel.text = message
  }

  private func providerTitle(_ kind: NativeLastLoginMethod) -> String {
    switch kind {
    case .github: String(localized: "auth.login.github", bundle: .lody)
    case .google: String(localized: "auth.login.google", bundle: .lody)
    case .apple: String(localized: "auth.login.apple", bundle: .lody)
    case .discord: String(localized: "auth.login.discord", bundle: .lody)
    case .email: String(localized: "auth.login.email", bundle: .lody)
    }
  }

  private func paintVerificationBody() {
    let address = verificationAddress.isEmpty ? trimmedEmail : verificationAddress
    let text = String.localizedStringWithFormat(String(localized: "auth.login.verificationBody", bundle: .lody), address)
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    paragraph.lineHeightMultiple = 1.3
    let body = NSMutableAttributedString(string: text, attributes: [
      .font: LoginType.description, .foregroundColor: LoginPalette.secondaryLabel, .paragraphStyle: paragraph,
    ])
    let range = (text as NSString).range(of: address)
    if !address.isEmpty, range.location != NSNotFound {
      body.addAttributes([.font: LoginType.font(15, .medium, style: .subheadline), .foregroundColor: LoginPalette.label], range: range)
    }
    verificationBody.attributedText = body
  }
}
