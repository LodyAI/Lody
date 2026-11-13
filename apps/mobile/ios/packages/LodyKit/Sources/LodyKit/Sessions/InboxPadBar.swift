import UIKit

// Regular width has no tab bar, so the list column carries the two actions iPhone keeps
// there: Settings (leading) and new chat (trailing). Search lives in the navigation bar,
// as on iPhone. UIKit retires the primary column's toolbar while the split hides or shows
// it, so this row lives inside the column and slides with it.
@MainActor
final class InboxPadBar: UIView {
  static let height: CGFloat = 44

  var openSettings: (() -> Void)?
  var openDebug: (() -> Void)?
  var create: (() -> Void)?
  var canCreate = false { didSet { createButton.isEnabled = canCreate } }
  private let settingsButton = UIButton(configuration: .glass())
  private let createButton = UIButton(configuration: .glass())
  private let edge = UIScrollEdgeElementContainerInteraction()

  override init(frame: CGRect) {
    super.init(frame: frame)
    var settings = UIButton.Configuration.glass()
    settings.image = UIImage(systemName: "gearshape")
    settings.baseForegroundColor = .label
    settingsButton.configuration = settings
    settingsButton.accessibilityLabel = String(localized: "tabs.settings", bundle: .lody)
    settingsButton.accessibilityIdentifier = "home-settings"
    settingsButton.addAction(UIAction { [weak self] _ in self?.openSettings?() }, for: .primaryActionTriggered)
    // Long-press Settings opens Debug, as the iPhone Settings tab does.
    let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
    settingsButton.addGestureRecognizer(hold)
    var create = UIButton.Configuration.glass()
    create.image = UIImage(systemName: "square.and.pencil")
    create.baseForegroundColor = .lodyAccent
    createButton.configuration = create
    createButton.accessibilityLabel = String(localized: "tabs.newSession", bundle: .lody)
    createButton.accessibilityIdentifier = "home-create"
    createButton.addAction(UIAction { [weak self] _ in self?.create?() }, for: .primaryActionTriggered)
    addSubview(settingsButton)
    addSubview(createButton)
    for view in [settingsButton, createButton] { view.translatesAutoresizingMaskIntoConstraints = false }
    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: Self.height),
      settingsButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      settingsButton.centerYAnchor.constraint(equalTo: centerYAnchor),
      settingsButton.widthAnchor.constraint(equalToConstant: Self.height),
      settingsButton.heightAnchor.constraint(equalToConstant: Self.height),
      createButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      createButton.centerYAnchor.constraint(equalTo: centerYAnchor),
      createButton.widthAnchor.constraint(equalToConstant: Self.height),
      createButton.heightAnchor.constraint(equalToConstant: Self.height),
    ])
    edge.edge = .bottom
    addInteraction(edge)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  // Only the two buttons take touches; the list stays scrollable between them.
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    [settingsButton, createButton].contains { $0.frame.contains(point) }
  }

  @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
    guard recognizer.state == .began else { return }
    openDebug?()
  }

  func attachScrollEdge(to scrollView: UIScrollView) {
    LodyScrollEdges.floatingControls(scrollView)
    edge.scrollView = scrollView
  }
}
