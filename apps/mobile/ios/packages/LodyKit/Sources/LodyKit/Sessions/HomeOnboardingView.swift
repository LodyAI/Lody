import LodyDesignSystem
import UIKit

// First-run guide on Chats for a workspace with no computers and no conversations
// (web `MobileHomeOnboarding`). The phone never opens the download page: both paths
// share or copy text for the computer that will run the agents.
@MainActor
final class HomeOnboardingView: UIView {
  static let command = "curl -fsSL 'https://api.lody.ai/install.sh' | sh -s -- --channel 'stable'"

  let scrollView = UIScrollView()
  /// Presents the share sheet; the owner supplies its view controller.
  var share: (([Any], UIView) -> Void)?
  private let stack = UIStackView()
  private let commandPill = UIButton(type: .system)
  private let linkCopy = UIButton(type: .system)
  private var cards: [UIView] = []
  private var copied: Kind?
  private var reset: DispatchWorkItem?

  private enum Kind { case command, link }

  private var downloadURL: String { Self.text("home.onboarding.downloadUrl") }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = LodyUIColor.bgBase
    scrollView.alwaysBounceVertical = true
    addSubview(scrollView)
    stack.axis = .vertical
    stack.spacing = LodySpacing.lg
    stack.translatesAutoresizingMaskIntoConstraints = false
    scrollView.addSubview(stack)
    let content = scrollView.contentLayoutGuide, viewport = scrollView.frameLayoutGuide
    let width = stack.widthAnchor.constraint(equalTo: viewport.widthAnchor, constant: -LodyLayout.listEdgeX * 2)
    width.priority = .defaultHigh
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: content.topAnchor, constant: LodySpacing.xxxl),
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -LodySpacing.xxl),
      content.widthAnchor.constraint(equalTo: viewport.widthAnchor),
      stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
      width,
    ])
    stack.addArrangedSubview(header())
    stack.addArrangedSubview(commandCard())
    stack.addArrangedSubview(desktopCard())
    stack.addArrangedSubview(nextSteps())
    render()
    // Layer borders hold resolved colours; refresh them when the appearance changes.
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _: UITraitCollection) in self.updateBorders() }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { reset?.cancel() }

  override func layoutSubviews() {
    super.layoutSubviews()
    scrollView.frame = bounds
  }

  // MARK: Sections

  private func header() -> UIView {
    let badge = UIView()
    badge.backgroundColor = LodyUIColor.fillTertiary
    badge.layer.cornerRadius = LodyRadius.lg
    badge.layer.cornerCurve = .continuous
    let icon = Self.icon(.monitorSmartphone, size: LodyIconSize.lg, tint: LodyUIColor.iconSecondary)
    icon.translatesAutoresizingMaskIntoConstraints = false
    badge.addSubview(icon)
    badge.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      badge.widthAnchor.constraint(equalToConstant: LodySize.controlLg),
      badge.heightAnchor.constraint(equalToConstant: LodySize.controlLg),
      icon.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
      icon.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
    ])
    let title = Self.label(Self.text("home.onboarding.title"), style: .headline, color: LodyUIColor.textPrimary)
    title.accessibilityTraits = .header
    let description = Self.label(Self.text("home.onboarding.description"), style: .bodySmall, color: LodyUIColor.textSecondary)
    for label in [title, description] { label.textAlignment = .center }
    let column = UIStackView(arrangedSubviews: [badge, title, description])
    column.axis = .vertical
    column.alignment = .center
    column.spacing = LodySpacing.sm
    column.setCustomSpacing(LodySpacing.md, after: badge)
    return column
  }

  private func commandCard() -> UIView {
    commandPill.accessibilityLabel = Self.text("home.onboarding.copyCommand")
    commandPill.accessibilityValue = Self.command
    commandPill.contentHorizontalAlignment = .fill
    commandPill.setContentHuggingPriority(.defaultLow, for: .horizontal)
    commandPill.heightAnchor.constraint(greaterThanOrEqualToConstant: LodySize.touchTarget).isActive = true
    commandPill.addAction(UIAction { [weak self] _ in self?.copy(Self.command, kind: .command) }, for: .primaryActionTriggered)
    let shareButton = Self.iconButton(.share, label: Self.text("home.onboarding.shareCommand"))
    shareButton.addAction(UIAction { [weak self, weak shareButton] _ in
      guard let self, let shareButton else { return }
      self.share?(["\(Self.command)\n\(self.downloadURL)"], shareButton)
    }, for: .primaryActionTriggered)
    let row = UIStackView(arrangedSubviews: [commandPill, shareButton])
    row.spacing = LodySpacing.sm
    row.alignment = .fill
    return card(icon: .terminal, heading: "home.onboarding.commandHeading", control: row, hint: "home.onboarding.commandHint")
  }

  private func desktopCard() -> UIView {
    var primary = UIButton.Configuration.filled()
    primary.baseBackgroundColor = .lodyInk
    primary.baseForegroundColor = .lodyGround
    primary.cornerStyle = .fixed
    primary.background.cornerRadius = LodyRadius.lg
    primary.image = Self.image(.share, size: LodyIconSize.sm)
    primary.imagePadding = LodySpacing.sm
    primary.attributedTitle = AttributedString(Self.text("home.onboarding.shareDownload"), attributes: AttributeContainer([.font: LodyTextStyle.subhead.uiFont]))
    let send = UIButton(configuration: primary)
    send.addAction(UIAction { [weak self, weak send] _ in
      guard let self, let send, let url = URL(string: self.downloadURL) else { return }
      self.share?([url], send)
    }, for: .primaryActionTriggered)
    linkCopy.accessibilityLabel = Self.text("home.onboarding.copyDownload")
    linkCopy.widthAnchor.constraint(equalToConstant: LodySize.touchTarget).isActive = true
    linkCopy.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.copy(self.downloadURL, kind: .link)
    }, for: .primaryActionTriggered)
    let row = UIStackView(arrangedSubviews: [send, linkCopy])
    row.spacing = LodySpacing.sm
    row.alignment = .fill
    send.heightAnchor.constraint(greaterThanOrEqualToConstant: LodySize.touchTarget).isActive = true
    return card(icon: .desktop, heading: "home.onboarding.desktopHeading", control: row, hint: "home.onboarding.desktopHint")
  }

  private func nextSteps() -> UIView {
    let heading = Self.label(Self.text("home.onboarding.nextStepsHeading"), style: .label, color: LodyUIColor.textTertiary)
    heading.accessibilityTraits = .header
    let column = UIStackView(arrangedSubviews: [heading])
    column.axis = .vertical
    column.spacing = LodySpacing.sm
    column.isLayoutMarginsRelativeArrangement = true
    column.directionalLayoutMargins = NSDirectionalEdgeInsets(top: LodySpacing.xs, leading: LodySpacing.xs, bottom: 0, trailing: LodySpacing.xs)
    for (index, key) in ["home.onboarding.nextStep.machine", "home.onboarding.nextStep.project", "home.onboarding.nextStep.agent"].enumerated() {
      let number = Self.label("\(index + 1)", style: .micro, color: LodyUIColor.textSecondary)
      number.textAlignment = .center
      number.backgroundColor = LodyUIColor.fillTertiary
      number.layer.cornerRadius = LodySize.badge / 2
      number.layer.masksToBounds = true
      number.isAccessibilityElement = false
      number.translatesAutoresizingMaskIntoConstraints = false
      let badge = UIView()
      badge.addSubview(number)
      NSLayoutConstraint.activate([
        number.widthAnchor.constraint(equalToConstant: LodySize.badge),
        number.heightAnchor.constraint(equalToConstant: LodySize.badge),
        number.topAnchor.constraint(equalTo: badge.topAnchor, constant: 1),
        number.leadingAnchor.constraint(equalTo: badge.leadingAnchor),
        number.trailingAnchor.constraint(equalTo: badge.trailingAnchor),
        number.bottomAnchor.constraint(lessThanOrEqualTo: badge.bottomAnchor),
      ])
      let text = Self.label(Self.text(key), style: .footnote, color: LodyUIColor.textSecondary)
      text.accessibilityLabel = "\(index + 1). \(text.text ?? "")"
      let row = UIStackView(arrangedSubviews: [badge, text])
      row.spacing = LodySpacing.sm + 2
      row.alignment = .top
      column.addArrangedSubview(row)
    }
    return column
  }

  private func card(icon: LodyIcon, heading: String, control: UIView, hint: String) -> UIView {
    let title = UIStackView(arrangedSubviews: [
      Self.icon(icon, size: LodyIconSize.sm, tint: LodyUIColor.iconSecondary),
      Self.label(Self.text(heading), style: .subhead, color: LodyUIColor.textPrimary),
    ])
    title.spacing = LodySpacing.sm
    title.alignment = .center
    (title.arrangedSubviews.last as? UILabel)?.accessibilityTraits = .header
    let column = UIStackView(arrangedSubviews: [title, control, Self.label(Self.text(hint), style: .footnote, color: LodyUIColor.textSecondary)])
    column.axis = .vertical
    column.spacing = LodySpacing.md
    column.isLayoutMarginsRelativeArrangement = true
    column.directionalLayoutMargins = NSDirectionalEdgeInsets(top: LodySpacing.lg, leading: LodySpacing.lg, bottom: LodySpacing.lg, trailing: LodySpacing.lg)
    column.backgroundColor = LodyUIColor.bgRaised
    column.layer.cornerRadius = LodyRadius.xl
    column.layer.cornerCurve = .continuous
    cards.append(column)
    updateBorders()
    return column
  }

  private func updateBorders() {
    let color = LodyUIColor.borderSubtle.resolvedColor(with: traitCollection).cgColor
    for card in cards {
      card.layer.borderWidth = 1 / max(1, traitCollection.displayScale)
      card.layer.borderColor = color
    }
  }

  // MARK: Copy feedback

  private func copy(_ text: String, kind: Kind) {
    UIPasteboard.general.string = text
    UIAccessibility.post(notification: .announcement, argument: Self.text("home.onboarding.copied"))
    copied = kind
    render()
    reset?.cancel()
    let next = DispatchWorkItem { [weak self] in
      self?.copied = nil
      self?.render()
    }
    reset = next
    DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: next)
  }

  private func render() {
    var pill = UIButton.Configuration.plain()
    pill.background.backgroundColor = LodyUIColor.bgSunken
    pill.background.cornerRadius = LodyRadius.lg
    pill.baseForegroundColor = LodyUIColor.textPrimary
    pill.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: LodySpacing.md, bottom: 10, trailing: LodySpacing.md)
    pill.titleAlignment = .leading
    pill.titleLineBreakMode = .byCharWrapping
    pill.attributedTitle = AttributedString(Self.command, attributes: AttributeContainer([.font: LodyTextStyle.codeSmall.uiFont]))
    pill.image = Self.image(copied == .command ? .check : .copy, size: LodyIconSize.sm)
    pill.imageColorTransformer = UIConfigurationColorTransformer { _ in LodyUIColor.iconSecondary }
    pill.imagePlacement = .trailing
    pill.imagePadding = LodySpacing.sm
    commandPill.configuration = pill
    linkCopy.configuration = Self.iconConfiguration(copied == .link ? .check : .copy)
  }

  // MARK: Helpers

  private static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue(key), bundle: .lody)
  }

  private static func label(_ text: String, style: LodyTextStyle, color: UIColor) -> UILabel {
    let label = UILabel()
    label.text = text
    label.font = style.uiFont
    label.textColor = color
    label.numberOfLines = 0
    label.adjustsFontForContentSizeCategory = true
    return label
  }

  private static func image(_ icon: LodyIcon, size: CGFloat) -> UIImage? {
    guard let source = icon.uiImage else { return nil }
    let box = CGSize(width: size, height: size)
    return UIGraphicsImageRenderer(size: box).image { _ in source.draw(in: CGRect(origin: .zero, size: box)) }
      .withRenderingMode(.alwaysTemplate)
  }

  private static func icon(_ icon: LodyIcon, size: CGFloat, tint: UIColor) -> UIImageView {
    let view = UIImageView(image: image(icon, size: size))
    view.tintColor = tint
    view.contentMode = .center
    view.setContentHuggingPriority(.required, for: .horizontal)
    view.setContentCompressionResistancePriority(.required, for: .horizontal)
    return view
  }

  private static func iconConfiguration(_ icon: LodyIcon) -> UIButton.Configuration {
    var configuration = UIButton.Configuration.plain()
    configuration.image = image(icon, size: LodyIconSize.sm)
    configuration.baseForegroundColor = LodyUIColor.iconSecondary
    configuration.background.backgroundColor = LodyUIColor.bgSunken
    configuration.background.cornerRadius = LodyRadius.lg
    return configuration
  }

  private static func iconButton(_ icon: LodyIcon, label: String) -> UIButton {
    let button = UIButton(configuration: iconConfiguration(icon))
    button.accessibilityLabel = label
    button.widthAnchor.constraint(equalToConstant: LodySize.touchTarget).isActive = true
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: LodySize.touchTarget).isActive = true
    return button
  }
}
