import UIKit

@MainActor
class OnboardingController: UIViewController {
  private static let features = [
    ("sessions", "bubble.left.and.text.bubble.right.fill"),
    ("reply", "paperplane.fill"),
    ("privacy", "lock.shield.fill"),
  ]

  private let service: OnboardingService
  private let intro = OnboardingIntro()
  private let scroll = UIScrollView()
  private let header = UIStackView()
  private let featureRows: [UIView]
  private let featureStack = UIStackView()
  private let waitingView = OnboardingWaitingView()
  private let footer = UIStackView()
  private let footnote = UIStackView()
  private let errorLabel = UILabel()
  private let button = UIButton(configuration: .prominentGlass())
  private var panelBottom: NSLayoutConstraint?
  private var observers: [NSObjectProtocol] = []
  private var state = OnboardingState()
  private var shown = false
  private var finished = false

  init(service: OnboardingService = .live) {
    self.service = service
    featureRows = Self.features.map { Self.featureRow(id: $0.0, symbol: $0.1) }
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "onboarding.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyBackground
    view.accessibilityIdentifier = "onboarding-sheet"
    buildContent()
    buildPanel()
    if let probe = intro.probe {
      probe.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
      view.addSubview(probe)
    }
    waitingView.reopen = { [weak self] in self?.service.reopen() }
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
    guard !shown else { return }
    shown = true
    play(header: true)
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    panelBottom?.constant = -max(view.safeAreaInsets.bottom, 16)
  }

  private func buildContent() {
    scroll.alwaysBounceVertical = true
    scroll.showsVerticalScrollIndicator = false
    scroll.contentInsetAdjustmentBehavior = .automatic
    scroll.translatesAutoresizingMaskIntoConstraints = false
    LodyScrollEdges.navigation(scroll)
    view.addSubview(scroll)

    let logo = UIImageView(image: UIImage(named: "onboarding-logo", in: Bundle.main, compatibleWith: nil)
      ?? UIImage(named: "onboarding-logo"))
    logo.accessibilityIgnoresInvertColors = true
    logo.layer.cornerRadius = 15
    logo.layer.cornerCurve = .continuous
    logo.clipsToBounds = true
    logo.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([logo.widthAnchor.constraint(equalToConstant: 64), logo.heightAnchor.constraint(equalToConstant: 64)])
    let titleLabel = UILabel()
    titleLabel.text = String(localized: "onboarding.title", bundle: .lody)
    titleLabel.font = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: .systemFont(ofSize: 30, weight: .bold))
    titleLabel.adjustsFontForContentSizeCategory = true
    titleLabel.attributedText = NSAttributedString(string: titleLabel.text ?? "", attributes: [.kern: -0.6])
    titleLabel.textAlignment = .center
    titleLabel.numberOfLines = 0
    titleLabel.accessibilityTraits = .header
    header.addArrangedSubview(logo)
    header.addArrangedSubview(titleLabel)
    header.axis = .vertical
    header.alignment = .center
    header.spacing = 14

    featureRows.forEach(featureStack.addArrangedSubview)
    featureStack.axis = .vertical
    featureStack.spacing = 24

    let content = UIStackView(arrangedSubviews: [header, featureStack, waitingView])
    content.axis = .vertical
    content.spacing = 36
    content.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(content)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 48),
      content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      content.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 28),
      content.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -28),
    ])
  }

  private func buildPanel() {
    let people = UIImageView(image: UIImage(systemName: "person.2.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20)))
    people.tintColor = .lodyAccent
    people.contentMode = .center
    let note = UILabel()
    note.text = String(localized: "login.footnote", bundle: .lody)
    note.font = UIFontMetrics(forTextStyle: .caption1).scaledFont(for: .systemFont(ofSize: 12))
    note.adjustsFontForContentSizeCategory = true
    note.textColor = .secondaryLabel
    note.textAlignment = .center
    note.numberOfLines = 0
    footnote.addArrangedSubview(people)
    footnote.addArrangedSubview(note)
    footnote.axis = .vertical
    footnote.alignment = .center
    footnote.spacing = 8
    footnote.isLayoutMarginsRelativeArrangement = true
    footnote.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)

    errorLabel.font = .preferredFont(forTextStyle: .body)
    errorLabel.adjustsFontForContentSizeCategory = true
    errorLabel.textColor = .systemRed
    errorLabel.textAlignment = .center
    errorLabel.numberOfLines = 0
    footer.addArrangedSubview(footnote)
    footer.addArrangedSubview(errorLabel)
    footer.axis = .vertical

    button.addAction(UIAction { [weak self] _ in self?.press() }, for: .primaryActionTriggered)
    button.translatesAutoresizingMaskIntoConstraints = false
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true

    let panel = UIStackView(arrangedSubviews: [footer, button])
    panel.axis = .vertical
    panel.spacing = 14
    panel.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(panel)
    let bottom = panel.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16)
    panelBottom = bottom
    NSLayoutConstraint.activate([
      panel.topAnchor.constraint(equalTo: scroll.bottomAnchor),
      panel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      panel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      bottom,
    ])
  }

  private func render() {
    let next = service.state()
    if next.signedIn {
      guard !finished else { return }
      finished = true
      LodyShell.shared.finish(from: self, value: nil)
      // Close the welcome container even when its authorization browser is on top.
      LodyShell.shared.close(from: self)
      return
    }
    let resumed = state.waiting && !next.waiting
    state = next
    featureStack.isHidden = next.waiting
    footer.isHidden = next.waiting
    waitingView.isHidden = !next.waiting
    waitingView.update(code: next.code)
    footnote.isHidden = next.error != nil
    errorLabel.isHidden = next.error == nil
    if let error = next.error, errorLabel.text != error { UIAccessibility.post(notification: .announcement, argument: error) }
    errorLabel.text = next.error
    applyButton()
    if resumed, shown { play(header: false) }
  }

  private func applyButton() {
    let waiting = state.waiting
    let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17, weight: .semibold))
    var configuration: UIButton.Configuration = .lodyProminent(font: font)
    if waiting {
      configuration = .glass()
      configuration.baseForegroundColor = .lodyAccent
      configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
        var attributes = attributes
        attributes.font = font
        return attributes
      }
    }
    var key = "login.connect"
    if waiting {
      key = "common.cancel"
    } else if state.error != nil {
      key = "login.retry"
    }
    configuration.title = String(localized: String.LocalizationValue(key), bundle: .lody)
    configuration.cornerStyle = .capsule
    button.configuration = configuration
    button.accessibilityIdentifier = waiting ? "auth-cancel" : "onboarding-connect"
    button.accessibilityLabel = String(localized: String.LocalizationValue(key), bundle: .lody)
  }

  private func press() {
    if state.waiting { service.cancel() } else { service.login() }
  }

  private func play(header animateHeader: Bool) {
    guard !state.waiting else {
      if animateHeader { intro.play([(header, 0)]) }
      return
    }
    var blocks = featureRows.enumerated().map { (view: $0.element, step: $0.offset + 1) }
    blocks.append((footer, 4))
    if animateHeader { blocks.insert((header, 0), at: 0) }
    intro.play(blocks)
  }

  private static func featureRow(id: String, symbol: String) -> UIView {
    let icon = UIImageView(image: UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 28)))
    icon.tintColor = .lodyAccent
    icon.contentMode = .center
    icon.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 36), icon.heightAnchor.constraint(equalToConstant: 36)])
    let title = UILabel()
    title.text = String(localized: String.LocalizationValue("onboarding." + id + ".title"), bundle: .lody)
    title.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17, weight: .semibold))
    title.adjustsFontForContentSizeCategory = true
    title.numberOfLines = 0
    let body = UILabel()
    body.text = String(localized: String.LocalizationValue("onboarding." + id + ".body"), bundle: .lody)
    body.font = .preferredFont(forTextStyle: .body)
    body.adjustsFontForContentSizeCategory = true
    body.textColor = .secondaryLabel
    body.numberOfLines = 0
    let text = UIStackView(arrangedSubviews: [title, body])
    text.axis = .vertical
    text.spacing = 2
    let iconColumn = UIStackView(arrangedSubviews: [icon])
    iconColumn.axis = .vertical
    iconColumn.isLayoutMarginsRelativeArrangement = true
    iconColumn.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 2, leading: 0, bottom: 0, trailing: 0)
    let row = UIStackView(arrangedSubviews: [iconColumn, text])
    row.axis = .horizontal
    row.alignment = .top
    row.spacing = 16
    row.isAccessibilityElement = true
    row.accessibilityLabel = [title.text, body.text].compactMap(\.self).joined(separator: ", ")
    return row
  }
}
