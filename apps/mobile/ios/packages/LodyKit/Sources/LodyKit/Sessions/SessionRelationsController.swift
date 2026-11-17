import UIKit
import LodyDesignSystem

/// A live, read-only tree. Native rows keep Tabs adjacent to their owning conversation.
final class SessionRelationsController: UIViewController, UICollectionViewDelegate {
  private let source: SessionSource
  private let current: String
  private let scope: String
  private var observers: [NSObjectProtocol] = []
  private var rows: [String: SessionRelations.Row] = [:]
  private var orderedRows: [SessionRelations.Row] = []
  private var collection: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  var onOpen: ((String) -> Void)?

  init(source: SessionSource, current: String) {
    self.source = source; self.current = current; self.scope = source.state.key
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "session.relations.title", bundle: .lody)
  }
  required init?(coder: NSCoder) { fatalError() }
  isolated deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

  override func viewDidLoad() {
    super.viewDidLoad()
    var layout = UICollectionLayoutListConfiguration(appearance: .plain)
    // Clear so the compact sheet keeps its system Liquid Glass surface.
    layout.backgroundColor = .clear
    layout.showsSeparators = false
    collection = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: layout))
    collection.backgroundColor = .clear
    collection.frame = view.bounds
    collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collection.delegate = self
    view.addSubview(collection)
    LodyScrollEdges.bind(collection, to: self)
    let registration = UICollectionView.CellRegistration<SessionRelationCell, SessionRelations.Row> { [weak self] cell, _, row in
      guard let self else { return }
      let items = row.sessions.map { session -> ConversationTabStrip.Item in
        let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        var item = ConversationTabStrip.Item(id: session.id, title: title.isEmpty ? String(localized: "session.operation.untitled", bundle: .lody) : title,
          cliType: session.cliType, agentType: session.agentType, current: session.id == current)
        let status = SessionState(session)
        if status == .failed {
          item.glyph = .failed
          item.status = String(localized: "session.operation.status.failed", bundle: .lody)
        } else if status == .attention {
          item.glyph = .attention
          item.status = String(localized: "session.relations.waiting", bundle: .lody)
        } else if status == .live {
          item.glyph = .live
          item.status = String(localized: "session.operation.status.running", bundle: .lody)
        } else if session.id != current && SessionRows.needsEmphasis(session) {
          item.glyph = .unread
          item.status = String(localized: "session.relations.unread", bundle: .lody)
        }
        return item
      }
      cell.strip.configure(items)
      cell.strip.onSelect = { [weak self] id in self?.open(id) }
      if let index = orderedRows.firstIndex(where: { $0.session.id == row.session.id }) {
        cell.branch = SessionRelations.branch(at: index, rows: orderedRows)
      }
      cell.hasDetail = items.contains { !$0.detail.isEmpty }
      cell.updateHeight()
      cell.setNeedsLayout()
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: collection) { [weak self] collection, index, id in
      guard let row = self?.rows[id] else { return nil }
      return collection.dequeueConfiguredReusableCell(using: registration, for: index, item: row)
    }
    observers = source.changes.map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      }
    }
    render()
  }

  private func render() {
    let state = source.state
    let tree = SessionRelations.tree(sessions: state.key == scope ? state.catalog.sessions : [], current: current)
    orderedRows = tree.rows
    rows = Dictionary(tree.rows.map { ($0.session.id, $0) }, uniquingKeysWith: { first, _ in first })
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(tree.rows.map { $0.session.id })
    snapshot.reconfigureItems(snapshot.itemIdentifiers.filter { dataSource.snapshot().indexOfItem($0) != nil })
    dataSource.apply(snapshot, animatingDifferences: false)
  }

  private func open(_ id: String) {
    guard source.state.key == scope,
      let target = SessionRelations.target(id, sessions: source.state.catalog.sessions) else { return }
    onOpen?(target)
  }
}

private final class SessionRelationCell: UICollectionViewListCell {
  let strip = ConversationTabStrip()
  private let rail = ConversationTreeRow()
  var branch = SessionRelations.Branch(depth: 0, continues: false, ancestors: [])
  var hasDetail = false
  private var rowHeight: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundConfiguration = .clear()
    isAccessibilityElement = false
    rail.showsAgent = false
    strip.rowPadding = LodySpacing.sm
    rail.accessibilityElementsHidden = true
    contentView.addSubview(rail)
    contentView.addSubview(strip)
    rowHeight = contentView.heightAnchor.constraint(equalToConstant: 44)
    rowHeight.isActive = true
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (cell: SessionRelationCell, _) in cell.updateHeight() }
  }
  required init?(coder: NSCoder) { fatalError() }
  func updateHeight() {
    rowHeight.constant = ConversationTreeRow.height(detail: hasDetail, traits: traitCollection)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    let margin = LodyLayout.screenPaddingX
    rail.detailLabel.text = hasDetail ? " " : nil
    rail.depth = branch.depth
    rail.continues = branch.continues
    rail.ancestorRails = branch.ancestors
    rail.frame = CGRect(x: margin, y: 0, width: CGFloat(branch.depth) * 24, height: bounds.height)
    rail.setNeedsLayout()
    // The strip's overflow fade masks its bounds, so it spans the capsule's padding instead of letting it overflow.
    let pad = strip.rowPadding
    strip.frame = CGRect(x: rail.frame.maxX - pad, y: 0, width: max(0, bounds.width - rail.frame.maxX - margin + 2 * pad), height: bounds.height)
  }
  override func prepareForReuse() {
    super.prepareForReuse()
    strip.configure([])
    strip.onSelect = nil
  }
}
