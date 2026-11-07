import UIKit

@MainActor
final class OnboardingWaitingView: UIStackView {
  var reopen: (() -> Void)?

  private let card = UIView()
  private let code = OnboardingCodeView()
  private let status = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    axis = .vertical
    spacing = 28

    let prompt = UILabel()
    prompt.text = String(localized: "login.verifyCode", bundle: .lody)
    prompt.font = .preferredFont(forTextStyle: .body)
    prompt.adjustsFontForContentSizeCategory = true
    prompt.textColor = .secondaryLabel
    prompt.numberOfLines = 0
    code.font = UIFontMetrics(forTextStyle: .title1).scaledFont(for: UIFont(name: "Menlo-Bold", size: 28) ?? .monospacedSystemFont(ofSize: 28, weight: .semibold))
    code.adjustsFontForContentSizeCategory = true
    code.textColor = .label
    code.backgroundColor = .clear
    code.isEditable = false
    code.isScrollEnabled = false
    code.textContainerInset = .zero
    code.textContainer.lineFragmentPadding = 0
    code.accessibilityIdentifier = "onboarding-code"
    var reopenConfiguration = UIButton.Configuration.plain()
    reopenConfiguration.title = String(localized: "login.reopen", bundle: .lody)
    reopenConfiguration.baseForegroundColor = .lodyAccent
    reopenConfiguration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0)
    let reopenButton = UIButton(configuration: reopenConfiguration)
    reopenButton.contentHorizontalAlignment = .leading
    reopenButton.addAction(UIAction { [weak self] _ in self?.reopen?() }, for: .primaryActionTriggered)
    let cardStack = UIStackView(arrangedSubviews: [prompt, code, reopenButton])
    cardStack.axis = .vertical
    cardStack.alignment = .leading
    cardStack.spacing = 10
    cardStack.translatesAutoresizingMaskIntoConstraints = false
    card.backgroundColor = .tertiarySystemFill
    card.layer.cornerRadius = 16
    card.layer.cornerCurve = .continuous
    card.addSubview(cardStack)
    NSLayoutConstraint.activate([
      cardStack.topAnchor.constraint(equalTo: card.topAnchor, constant: 20),
      cardStack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
      cardStack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
      cardStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
    ])

    let spinner = UIActivityIndicatorView(style: .medium)
    spinner.color = .secondaryLabel
    spinner.startAnimating()
    status.font = .preferredFont(forTextStyle: .body)
    status.adjustsFontForContentSizeCategory = true
    status.textColor = .secondaryLabel
    status.numberOfLines = 0
    let progress = UIStackView(arrangedSubviews: [spinner, status])
    progress.axis = .horizontal
    progress.alignment = .center
    progress.spacing = 10
    let progressRow = UIStackView(arrangedSubviews: [progress])
    progressRow.axis = .vertical
    progressRow.alignment = .center

    addArrangedSubview(card)
    addArrangedSubview(progressRow)
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError() }

  func update(code value: String?) {
    card.isHidden = value == nil
    if code.text != value { code.text = value }
    status.text = String(localized: String.LocalizationValue(value == nil ? "login.connecting" : "login.waiting"), bundle: .lody)
  }
}

private final class OnboardingCodeView: UITextView {
  override var accessibilityLabel: String? {
    get { text }
    set {}
  }
}
