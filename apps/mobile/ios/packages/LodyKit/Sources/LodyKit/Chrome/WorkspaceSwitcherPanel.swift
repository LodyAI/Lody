import UIKit

/// The workspace switcher: a compact native list in a popover anchored to the workspace capsule
/// (never adapted to a sheet). Each 44 pt row leads with the workspace logo (its initial until the
/// logo loads) and ends with a checkmark on the current workspace, which also carries the
/// VoiceOver selected trait. Choosing a row closes the panel before switching.
@MainActor
final class WorkspaceSwitcherPanel: UIViewController, UICollectionViewDelegate, UIPopoverPresentationControllerDelegate {
  private static let rowHeight: CGFloat = 44
  private static let avatarSide: CGFloat = 24
  private static let inset: CGFloat = 6
  private var items: [LodyMenuItem]
  private let picked: (String) -> Void
  private var list: UICollectionView!
  private var data: UICollectionViewDiffableDataSource<Int, String>!
  private var loading = Set<URL>()

  init(items: [LodyMenuItem], picked: @escaping (String) -> Void) {
    self.items = items
    self.picked = picked
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
    configuration.backgroundColor = .clear
    configuration.showsSeparators = false
    list = UICollectionView(frame: view.bounds, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: configuration))
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.backgroundColor = .clear
    list.contentInset = UIEdgeInsets(top: Self.inset, left: 0, bottom: Self.inset, right: 0)
    list.accessibilityIdentifier = "workspace-panel"
    list.delegate = self
    view.addSubview(list)
    let registration = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
      guard let self, let item = self.items.first(where: { $0.id == id }) else { return }
      self.configure(cell, item)
    }
    data = UICollectionViewDiffableDataSource(collectionView: list) { collection, indexPath, id in
      collection.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
    }
    apply(reconfigure: false)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    resize()
  }

  func update(_ next: [LodyMenuItem]) {
    guard next != items else { return }
    items = next
    guard isViewLoaded else { return }
    apply(reconfigure: true)
    resize()
  }

  private func apply(reconfigure: Bool) {
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(items.map(\.id))
    if reconfigure { snapshot.reconfigureItems(snapshot.itemIdentifiers) }
    data.apply(snapshot, animatingDifferences: false)
  }

  private func resize() {
    let visibleRows = min(CGFloat(items.count), 8)
    let names = items.map { ($0.title as NSString).size(withAttributes: [.font: UIFont.preferredFont(forTextStyle: .body)]).width }
    // Leading margin, logo, gap, name, gap, checkmark, trailing margin.
    let width = (names.max() ?? 0) + 16 + Self.avatarSide + 12 + 12 + 24 + 16
    preferredContentSize = CGSize(width: min(max(width, 240), 340), height: visibleRows * Self.rowHeight + Self.inset * 2)
  }

  private func configure(_ cell: UICollectionViewListCell, _ item: LodyMenuItem) {
    var content = UIListContentConfiguration.cell()
    content.text = item.title
    content.textProperties.numberOfLines = 1
    content.textProperties.lineBreakMode = .byTruncatingTail
    content.textProperties.color = .lodyInk
    content.image = avatar(item)
    content.imageProperties.maximumSize = CGSize(width: Self.avatarSide, height: Self.avatarSide)
    content.imageProperties.reservedLayoutSize = CGSize(width: Self.avatarSide, height: Self.avatarSide)
    content.imageProperties.cornerRadius = Self.avatarSide / 2
    content.imageToTextPadding = 12
    content.directionalLayoutMargins.top = 10
    content.directionalLayoutMargins.bottom = 10
    cell.contentConfiguration = content
    cell.accessories = item.selected ? [.checkmark(displayed: .always, options: .init(tintColor: .lodyInk))] : []
    var background = UIBackgroundConfiguration.listCell()
    background.backgroundColor = .clear
    cell.backgroundConfiguration = background
    cell.accessibilityIdentifier = "workspace-row:" + item.id
    cell.accessibilityLabel = item.title
    cell.accessibilityTraits = item.selected ? [.button, .selected] : [.button]
  }

  /// The cached logo, else the initial while the logo loads (the row redraws when it arrives).
  private func avatar(_ item: LodyMenuItem) -> UIImage {
    if let url = LodyListPhoto.url(item.photo) {
      if let photo = LodyListPhoto.cached(url) { return photo }
      if loading.insert(url).inserted {
        LodyListPhoto.load(url) { [weak self] loaded in
          guard let self else { return }
          self.loading.remove(url)
          guard loaded != nil, self.isViewLoaded else { return }
          let ids = self.items.filter { LodyListPhoto.url($0.photo) == url }.map(\.id)
          var snapshot = self.data.snapshot()
          snapshot.reconfigureItems(ids.filter { snapshot.indexOfItem($0) != nil })
          self.data.apply(snapshot, animatingDifferences: false)
        }
      }
    }
    return LodyListPhoto.monogram(item.monogram, side: Self.avatarSide)
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = data.itemIdentifier(for: indexPath) else { return }
    let picked = picked
    let current = items.first(where: { $0.id == id })?.selected == true
    dismiss(animated: true) {
      if !current { picked(id) }
    }
  }

  // A menu-like panel on iPhone too: never adapt the popover into a sheet.
  func adaptivePresentationStyle(for controller: UIPresentationController, traitCollection: UITraitCollection) -> UIModalPresentationStyle {
    .none
  }

  func adaptivePresentationStyle(for controller: UIPresentationController) -> UIModalPresentationStyle {
    .none
  }
}
