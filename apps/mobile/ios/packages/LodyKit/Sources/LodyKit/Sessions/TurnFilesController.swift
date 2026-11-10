import UIKit

/// A turn's changed files in a near full-screen sheet (the output card's files row): an
/// inset-grouped list, one row per file — its name, the folder it sits in, and its +/− counts —
/// driven by a diffable snapshot keyed by path, so files arriving or changing animate in place.
/// A row pushes the file's diff inside the sheet.
@MainActor
final class TurnFilesController: UIViewController, UICollectionViewDelegate {
  struct File: Hashable {
    let path: String
    let added: Int
    let removed: Int
  }

  let entryId: String
  var onOpen: ((String) -> Void)?
  var fileCount: Int { files.count }
  private var files: [File] = []
  private var byPath: [String: File] = [:]
  private lazy var collection = UICollectionView(frame: .zero, collectionViewLayout: {
    var configuration = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
    configuration.backgroundColor = .lodyGroupedBackground
    return UICollectionViewCompositionalLayout.list(using: configuration)
  }())
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!

  init(entryId: String) {
    self.entryId = entryId
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyGroupedBackground
    collection.frame = view.bounds
    collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collection.delegate = self
    view.addSubview(collection)
    let registration = UICollectionView.CellRegistration<UICollectionViewListCell, File> { cell, _, file in
      var content = UIListContentConfiguration.subtitleCell()
      let name = (file.path as NSString).lastPathComponent
      let folder = (file.path as NSString).deletingLastPathComponent
      content.text = name
      content.textProperties.font = LodyDesign.mono(14)
      content.textProperties.numberOfLines = 1
      content.textProperties.lineBreakMode = .byTruncatingMiddle
      if !folder.isEmpty {
        content.secondaryText = folder
        content.secondaryTextProperties.font = .preferredFont(forTextStyle: .caption1)
        content.secondaryTextProperties.color = .secondaryLabel
        content.secondaryTextProperties.lineBreakMode = .byTruncatingHead
      }
      cell.contentConfiguration = content
      let counts = UILabel()
      counts.font = LodyDesign.mono(12, compatibleWith: cell.traitCollection)
      let value = NSMutableAttributedString(string: "+\(file.added)", attributes: [.foregroundColor: UIColor.systemGreen])
      value.append(NSAttributedString(string: "  −\(file.removed)", attributes: [.foregroundColor: UIColor.systemRed]))
      counts.attributedText = value
      cell.accessories = [.customView(configuration: .init(customView: counts, placement: .trailing())), .disclosureIndicator()]
      cell.accessibilityLabel = String.localizedStringWithFormat(
        String(localized: "native.chat.file.diffStats", bundle: .lody),
        String(describing: file.added), String(describing: file.removed), String(describing: file.path)
      )
      cell.accessibilityHint = String(localized: "native.chat.row.openChanges", bundle: .lody)
    }
    dataSource = UICollectionViewDiffableDataSource(collectionView: collection) { [weak self] collection, index, path in
      guard let file = self?.byPath[path] else { return nil }
      return collection.dequeueConfiguredReusableCell(using: registration, for: index, item: file)
    }
    apply(animated: false)
  }

  /// The feed's entries JSON; only this entry's `fileDiffs` are read.
  func update(_ entriesJSON: String) {
    let entries = (try? JSONSerialization.jsonObject(with: Data(entriesJSON.utf8))) as? [[String: Any]] ?? []
    let diffs = entries.first { $0["id"] as? String == entryId }?["fileDiffs"] as? [[String: Any]] ?? []
    files = diffs.compactMap { diff in
      guard let path = diff["path"] as? String, !path.isEmpty else { return nil }
      return File(path: path, added: (diff["add"] as? NSNumber)?.intValue ?? 0, removed: (diff["del"] as? NSNumber)?.intValue ?? 0)
    }
    if isViewLoaded { apply(animated: true) }
  }

  private func apply(animated: Bool) {
    let previous = byPath
    byPath = Dictionary(files.map { ($0.path, $0) }, uniquingKeysWith: { _, last in last })
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    var seen = Set<String>()
    let paths = files.map(\.path).filter { seen.insert($0).inserted }
    snapshot.appendItems(paths)
    snapshot.reconfigureItems(paths.filter { previous[$0] != nil && previous[$0] != byPath[$0] })
    dataSource.apply(snapshot, animatingDifferences: animated && view.window != nil)
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let path = dataSource.itemIdentifier(for: indexPath) else { return }
    onOpen?(path)
  }
}
