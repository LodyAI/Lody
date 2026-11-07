import UIKit

// UIKit retires the primary column's toolbar while the split hides or shows it, so the
// sidebar's bottom row lives inside the column and slides with it.
@MainActor
final class InboxPadBar: UIView {
  static let height: CGFloat = 44

  let search = UISearchTextField()
  var searchChanged: ((String) -> Void)?
  var create: (() -> Void)?
  private let searchGlass = UIVisualEffectView(effect: UIGlassEffect())
  private let createButton = UIButton(configuration: .glass())
  private let edge = UIScrollEdgeElementContainerInteraction()

  override init(frame: CGRect) {
    super.init(frame: frame)
    searchGlass.cornerConfiguration = .capsule()
    search.placeholder = String(localized: "search.field.placeholder", bundle: .lody)
    search.borderStyle = .none
    search.backgroundColor = .clear
    search.returnKeyType = .search
    search.accessibilityIdentifier = "sidebar-search"
    search.accessibilityTraits.insert(.searchField)
    search.addAction(UIAction { [weak self] _ in self?.searchChanged?(self?.search.text ?? "") }, for: .editingChanged)
    search.addAction(UIAction { [weak self] _ in self?.search.resignFirstResponder() }, for: .editingDidEndOnExit)
    var configuration = UIButton.Configuration.glass()
    configuration.image = UIImage(systemName: "plus")
    configuration.baseForegroundColor = .lodyAccent
    createButton.configuration = configuration
    createButton.accessibilityLabel = String(localized: "tabs.newSession", bundle: .lody)
    createButton.addAction(UIAction { [weak self] _ in self?.create?() }, for: .primaryActionTriggered)
    addSubview(searchGlass)
    searchGlass.contentView.addSubview(search)
    addSubview(createButton)
    for view in [searchGlass, search, createButton] { view.translatesAutoresizingMaskIntoConstraints = false }
    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: Self.height),
      searchGlass.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      searchGlass.topAnchor.constraint(equalTo: topAnchor),
      searchGlass.bottomAnchor.constraint(equalTo: bottomAnchor),
      search.leadingAnchor.constraint(equalTo: searchGlass.contentView.leadingAnchor, constant: 10),
      search.trailingAnchor.constraint(equalTo: searchGlass.contentView.trailingAnchor, constant: -10),
      search.topAnchor.constraint(equalTo: searchGlass.contentView.topAnchor),
      search.bottomAnchor.constraint(equalTo: searchGlass.contentView.bottomAnchor),
      createButton.leadingAnchor.constraint(equalTo: searchGlass.trailingAnchor, constant: 12),
      createButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      createButton.centerYAnchor.constraint(equalTo: centerYAnchor),
      createButton.widthAnchor.constraint(equalToConstant: Self.height),
      createButton.heightAnchor.constraint(equalToConstant: Self.height),
    ])
    edge.edge = .bottom
    addInteraction(edge)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func attachScrollEdge(to scrollView: UIScrollView) {
    LodyScrollEdges.floatingControls(scrollView)
    edge.scrollView = scrollView
  }
}
