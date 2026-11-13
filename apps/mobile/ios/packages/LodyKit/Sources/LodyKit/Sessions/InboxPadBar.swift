import LodyDesignSystem
import UIKit

// Regular width has no tab bar, so the list column carries its counterpart: a glass capsule
// with Chats, Schedules and Settings (leading) and the create action (trailing). Chats and
// Schedules swap the column's root page; Settings opens its sheet (long-press opens Debug).
// Search lives in the navigation bar, as on iPhone. UIKit retires the primary column's
// toolbar while the split hides or shows it, so this row lives inside the column and slides with it.
@MainActor
final class InboxPadBar: UIView {
  static let height: CGFloat = 44

  var select: ((HomeTab) -> Void)?
  var openSettings: (() -> Void)?
  var openDebug: (() -> Void)?
  var create: (() -> Void)?
  var canCreate = false { didSet { createButton.isEnabled = canCreate } }
  /// The page this bar belongs to: its tab reads as selected and the create action follows it.
  var destination: HomeTab = .chats { didSet { if destination != oldValue { apply() } } }
  private let tabsGlass = UIVisualEffectView(effect: UIGlassEffect())
  private let tabs = UIStackView()
  private var buttons: [HomeTab: UIButton] = [:]
  private let createButton = UIButton(configuration: .glass())
  private let edge = UIScrollEdgeElementContainerInteraction()

  override init(frame: CGRect) {
    super.init(frame: frame)
    tabsGlass.cornerConfiguration = .capsule()
    tabs.axis = .horizontal
    tabs.distribution = .fillEqually
    for tab in HomeTab.allCases {
      let button = UIButton(configuration: .plain())
      button.accessibilityIdentifier = "home-tab-\(tab)"
      button.accessibilityLabel = tab.title
      button.addAction(UIAction { [weak self] _ in self?.pressed(tab) }, for: .primaryActionTriggered)
      if tab == .settings {
        button.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(held(_:))))
      }
      buttons[tab] = button
      tabs.addArrangedSubview(button)
    }
    createButton.accessibilityIdentifier = "home-create"
    createButton.addAction(UIAction { [weak self] _ in self?.create?() }, for: .primaryActionTriggered)
    addSubview(tabsGlass)
    tabsGlass.contentView.addSubview(tabs)
    addSubview(createButton)
    for view in [tabsGlass, tabs, createButton] { view.translatesAutoresizingMaskIntoConstraints = false }
    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: Self.height),
      tabsGlass.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      tabsGlass.topAnchor.constraint(equalTo: topAnchor),
      tabsGlass.bottomAnchor.constraint(equalTo: bottomAnchor),
      tabs.leadingAnchor.constraint(equalTo: tabsGlass.contentView.leadingAnchor, constant: 4),
      tabs.trailingAnchor.constraint(equalTo: tabsGlass.contentView.trailingAnchor, constant: -4),
      tabs.topAnchor.constraint(equalTo: tabsGlass.contentView.topAnchor),
      tabs.bottomAnchor.constraint(equalTo: tabsGlass.contentView.bottomAnchor),
      tabs.widthAnchor.constraint(equalToConstant: Self.height * CGFloat(HomeTab.allCases.count)),
      createButton.leadingAnchor.constraint(greaterThanOrEqualTo: tabsGlass.trailingAnchor, constant: 12),
      createButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      createButton.centerYAnchor.constraint(equalTo: centerYAnchor),
      createButton.widthAnchor.constraint(equalToConstant: Self.height),
      createButton.heightAnchor.constraint(equalToConstant: Self.height),
    ])
    edge.edge = .bottom
    addInteraction(edge)
    apply()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  // Only the controls take touches; the list stays scrollable between them.
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    tabsGlass.frame.contains(point) || createButton.frame.contains(point)
  }

  func attachScrollEdge(to scrollView: UIScrollView) {
    LodyScrollEdges.floatingControls(scrollView)
    edge.scrollView = scrollView
  }

  private func apply() {
    for (tab, button) in buttons {
      var configuration = UIButton.Configuration.plain()
      configuration.image = tab.icon.uiImage?.withRenderingMode(.alwaysTemplate)
      let selected = tab == destination
      configuration.baseForegroundColor = selected ? LodyUIColor.accentFg : LodyUIColor.iconSecondary
      button.configuration = configuration
      button.accessibilityTraits = selected ? [.button, .selected] : .button
    }
    // As the iPhone create action: compose glyph, adding a schedule on Schedules and a chat elsewhere.
    var create = UIButton.Configuration.glass()
    create.image = LodyIcon.compose.uiImage?.withRenderingMode(.alwaysTemplate)
    create.baseForegroundColor = LodyUIColor.accentFg
    createButton.configuration = create
    createButton.accessibilityLabel = String(
      localized: String.LocalizationValue(destination == .schedules ? "schedules.new" : "tabs.newSession"), bundle: .lody
    )
  }

  private func pressed(_ tab: HomeTab) {
    if tab == .settings { openSettings?() } else { select?(tab) }
  }

  @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
    guard recognizer.state == .began else { return }
    openDebug?()
  }
}
