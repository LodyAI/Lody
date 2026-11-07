import UIKit

private struct SidebarItemID: Hashable {
  let section: String
  let row: String
}

private final class SidebarAppearanceController: UIViewController {
  var onWillAppear: ((Bool, UIViewControllerTransitionCoordinator?) -> Void)?
  var onWillDisappear: ((Bool, UIViewControllerTransitionCoordinator?) -> Void)?
  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    onWillAppear?(animated, transitionCoordinator ?? parent?.transitionCoordinator)
  }
  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    onWillDisappear?(animated, transitionCoordinator ?? parent?.transitionCoordinator)
  }
}

/// Owns sidebar layout, outline expansion and persistent detail selection.
/// The grouped host is deliberately not in this view's rendering path.
final class LodySidebar: LodyAppearanceView, UICollectionViewDelegate {
  var onRowPress: ([String: Any]) -> Void = { _ in }
  var onRowAction: ([String: Any]) -> Void = { _ in }
  var previewUserId = ""
  var previewWorkspaceId = ""
  private var sections: [LodyListSection] = []
  private var rows: [SidebarItemID: LodyListRow] = [:]
  private var unreadHold = LodyUnreadNavigationHold()
  private var collapsedSessions = Set<String>()
  private var selectedRowId = ""
  private var accent: UIColor = .lodyAccent
  private let appearance = SidebarAppearanceController()
  private weak var scrollOwner: UIViewController?
  private let collection: UICollectionView
  var scrollView: UIScrollView { collection }
  private let placeholder = UILabel()
  private var dataSource: UICollectionViewDiffableDataSource<String, SidebarItemID>!

  private lazy var registration = UICollectionView.CellRegistration<UICollectionViewListCell, LodyListRow> { [weak self] cell, _, row in
    self?.configure(cell, row: row)
  }
  private lazy var headerRegistration = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
    elementKind: UICollectionView.elementKindSectionHeader
  ) { [weak self] cell, _, index in
    guard let self, let id = self.dataSource.sectionIdentifier(for: index.section),
          let section = self.sections.first(where: { $0.id == id }) else { return }
    var content = UIListContentConfiguration.header()
    content.text = section.header
    cell.contentConfiguration = content
    cell.backgroundConfiguration = .clear()
    cell.accessibilityTraits = .header
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    collection = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: .init(appearance: .sidebar)))
    super.init(frame: frame)
    _ = registration
    _ = headerRegistration
    backgroundColor = .lodySidebar
    collection.backgroundColor = .lodySidebar
    collection.tintColor = accent
    collection.contentInsetAdjustmentBehavior = .automatic
    collection.alwaysBounceVertical = true
    collection.keyboardDismissMode = .onDrag
    LodyScrollEdges.grouped(collection)
    collection.delegate = self
    dataSource = UICollectionViewDiffableDataSource(collectionView: collection) { [weak self] collection, index, id in
      guard let self, let row = self.rows[id] else { return nil }
      return collection.dequeueConfiguredReusableCell(using: self.registration, for: index, item: self.displayed(row))
    }
    dataSource.supplementaryViewProvider = { [weak self] collection, _, index in
      guard let self else { return nil }
      return collection.dequeueConfiguredReusableSupplementary(using: self.headerRegistration, for: index)
    }
    dataSource.sectionSnapshotHandlers.willExpandItem = { [weak self] item in
      self?.outlineChanged(item, expanded: true)
    }
    dataSource.sectionSnapshotHandlers.willCollapseItem = { [weak self] item in
      self?.outlineChanged(item, expanded: false)
    }
    let layout = UICollectionViewCompositionalLayout { [weak self] index, environment in
      guard let self, let id = self.dataSource.sectionIdentifier(for: index),
            let model = self.sections.first(where: { $0.id == id }) else { return nil }
      var configuration = UICollectionLayoutListConfiguration(appearance: .sidebar)
      configuration.backgroundColor = .clear
      configuration.showsSeparators = false
      configuration.headerMode = model.rows.first?.parent == true || model.header.isEmpty ? .none : .supplementary
      configuration.leadingSwipeActionsConfigurationProvider = { [weak self] in self?.swipes(at: $0, leading: true) }
      configuration.trailingSwipeActionsConfigurationProvider = { [weak self] in self?.swipes(at: $0, leading: false) }
      let section = NSCollectionLayoutSection.list(using: configuration, layoutEnvironment: environment)
      var top: CGFloat = 4
      if index > 0, model.rows.first?.parent == true {
        top = LodyDesign.Rail.compactBandGap
      } else if index > 0 {
        top = model.gap == .group ? LodyDesign.Rail.compactGroupGap : LodyDesign.Rail.compactSectionGap
      }
      section.contentInsets = .init(top: top, leading: 12, bottom: 0, trailing: 12)
      return section
    }
    collection.setCollectionViewLayout(layout, animated: false)
    addSubview(collection)
    placeholder.font = .preferredFont(forTextStyle: .subheadline)
    placeholder.adjustsFontForContentSizeCategory = true
    placeholder.textColor = .secondaryLabel
    placeholder.textAlignment = .center
    placeholder.numberOfLines = 0
    addSubview(placeholder)
    appearance.view = UIView(frame: .zero)
    appearance.view.isUserInteractionEnabled = false
    appearance.onWillAppear = { [weak self] animated, coordinator in
      self?.deselectOnReturn(animated: animated, coordinator: coordinator)
    }
    appearance.onWillDisappear = { [weak self] _, coordinator in
      self?.finishUnreadHold(coordinator: coordinator)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    collection.frame = bounds
    let inset = collection.adjustedContentInset
    placeholder.frame = bounds.inset(by: .init(top: inset.top + 24, left: 24, bottom: inset.bottom + 24, right: 24))
    attachScrollOwner()
  }

  override func willMove(toSuperview newSuperview: UIView?) {
    if newSuperview == nil, appearance.parent != nil {
      appearance.willMove(toParent: nil)
      appearance.view.removeFromSuperview()
      appearance.removeFromParent()
    }
    super.willMove(toSuperview: newSuperview)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      if scrollOwner?.contentScrollView(for: .top) === collection {
        if let scrollOwner { LodyScrollEdges.unbind(collection, from: scrollOwner) }
      }
      scrollOwner = nil
    } else {
      attachScrollOwner()
    }
  }

  private func attachScrollOwner() {
    guard window != nil, scrollOwner == nil else { return }
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController {
        LodyScrollEdges.bind(collection, to: controller)
        LodyScrollEdges.grouped(collection)
        scrollOwner = controller
        if appearance.parent == nil {
          controller.addChild(appearance)
          addSubview(appearance.view)
          appearance.didMove(toParent: controller)
        }
        return
      }
      responder = current.next
    }
  }

  private func toggleOutline(_ id: String) {
    guard let item = rows.keys.first(where: { $0.row == id }) else { return }
    var snapshot = dataSource.snapshot(for: item.section)
    guard snapshot.contains(item) else { return }
    let expanded = !snapshot.isExpanded(item)
    if expanded {
      snapshot.expand([item])
    } else {
      snapshot.collapse([item])
    }
    dataSource.apply(snapshot, to: item.section, animatingDifferences: !UIAccessibility.isReduceMotionEnabled)
    outlineChanged(item, expanded: expanded)
  }

  private func outlineChanged(_ item: SidebarItemID, expanded: Bool) {
    guard let row = rows[item] else { return }
    if row.parent {
      onRowPress(["id": item.row, "expanded": expanded])
      return
    }
    if expanded { collapsedSessions.remove(item.row) }
    else { collapsedSessions.insert(item.row) }
    // UIKit finishes its outline update before refreshing the parent's summary.
    DispatchQueue.main.async { [weak self] in
      guard let self, let index = self.dataSource.indexPath(for: item),
            let cell = self.collection.cellForItem(at: index) as? UICollectionViewListCell,
            let current = self.rows[item] else { return }
      self.configure(cell, row: self.displayed(current))
    }
  }

  func setSections(_ value: [LodyListSection]) {
    let previous = dataSource.snapshot()
    sections = value
    rows = Dictionary(value.flatMap { section in
      section.rows.map { (SidebarItemID(section: section.id, row: $0.id), $0) }
    }, uniquingKeysWith: { _, latest in latest })
    let sameSections = previous.sectionIdentifiers == value.map(\.id)
    if !sameSections {
      var snapshot = NSDiffableDataSourceSnapshot<String, SidebarItemID>()
      snapshot.appendSections(value.map(\.id))
      dataSource.apply(snapshot, animatingDifferences: false)
    }
    for section in value {
      let snapshot = section.outlineSnapshot(collapsed: collapsedSessions) {
        SidebarItemID(section: section.id, row: $0)
      }
      dataSource.apply(snapshot, to: section.id, animatingDifferences: sameSections && window != nil && !UIAccessibility.isReduceMotionEnabled) { [weak self] in
        // A deep link can select before its catalog snapshot arrives. Read the
        // current detail, never a captured row from an earlier navigation.
        self?.synchronizeSelection()
      }
    }
    // Reconfigure visible content independently of snapshot animation.
    updateVisibleRows()
    placeholder.isHidden = !value.allSatisfy { $0.rows.isEmpty }
    collection.collectionViewLayout.invalidateLayout()
  }

  func setSelectedRowId(_ value: String) {
    guard value != selectedRowId else { return }
    selectedRowId = value
    synchronizeSelection()
    updateVisibleRows()
  }

  private func synchronizeSelection() {
    if let current = collection.indexPathsForSelectedItems?.first,
       let row = row(at: current), row.navigates, row.preview != "session" {
      return
    }
    let index = rows.keys.first { $0.row == selectedRowId }.flatMap { dataSource.indexPath(for: $0) }
    let selection = index.map { [$0] } ?? []
    if (collection.indexPathsForSelectedItems ?? []) != selection {
      collection.selectItem(at: index, animated: false, scrollPosition: [])
    }
  }

  private func indexPath(for id: String) -> IndexPath? {
    rows.keys.first { $0.row == id }.flatMap { dataSource.indexPath(for: $0) }
  }

  private func displayed(_ row: LodyListRow) -> LodyListRow {
    var copy = row.displayingCollapsed(collapsedSessions.contains(row.id), keepingTime: true)
    copy.unread = unreadHold.applied(rowID: row.id, unread: row.unread)
    return copy
  }

  private func finishUnreadHold(coordinator: UIViewControllerTransitionCoordinator?) {
    guard unreadHold.isHolding else { return }
    let apply = { [weak self] in self?.releaseUnreadHold() }
    guard let coordinator else {
      apply()
      return
    }
    let started = coordinator.animate(alongsideTransition: nil, completion: { _ in apply() })
    if !started { apply() }
  }

  private func releaseUnreadHold() {
    guard unreadHold.end() != nil else { return }
    updateVisibleRows()
  }

  private func navigatingSelection() -> LodyListRow? {
    guard let current = collection.indexPathsForSelectedItems?.first,
          let row = row(at: current), row.navigates, row.preview != "session" else { return nil }
    return row
  }

  private func rowAppearsSelected(_ row: LodyListRow) -> Bool {
    if let navigating = navigatingSelection() { return row.id == navigating.id }
    return row.id == selectedRowId
  }

  func setAccent(_ value: String) {
    accent = lodyTint(value) ?? .lodyAccent
    collection.tintColor = accent
    updateVisibleRows()
  }

  func setPlaceholder(_ value: String) { placeholder.text = value }

  private func updateVisibleRows() {
    for index in collection.indexPathsForVisibleItems {
      guard let cell = collection.cellForItem(at: index) as? UICollectionViewListCell,
            let row = row(at: index) else { continue }
      configure(cell, row: displayed(row))
    }
  }

  private func configure(_ cell: UICollectionViewListCell, row: LodyListRow) {
    let id = row.id
    let project = row.parent || row.id.hasPrefix("project:")
    if project {
      let content = LodyProjectRowContent(
        row: row,
        density: .compact,
        expanded: row.parent && !row.navigates ? true : nil,
        onToggle: { [weak self] in self?.toggleOutline(id) }
      )
      cell.contentConfiguration = content
      cell.accessibilityLabel = content.accessibilityLabel
    } else {
      let expanded = !collapsedSessions.contains(id)
      var content = LodySessionRowContent(
        row: row, density: .compact, treeDown: !row.collapsedValue.isEmpty && expanded, expanded: expanded
      )
      if !row.collapsedValue.isEmpty {
        content.onToggle = { [weak self] in self?.toggleOutline(id) }
      }
      cell.contentConfiguration = content
      cell.accessibilityLabel = content.accessibilityLabel
    }
    cell.isAccessibilityElement = true
    cell.indentationWidth = 0
    cell.accessibilityIdentifier = row.id
    cell.accessibilityTraits = project ? [.button, .header] : .button
    if rowAppearsSelected(row) { cell.accessibilityTraits.insert(.selected) }
    cell.accessories = []
    cell.automaticallyUpdatesBackgroundConfiguration = false
    cell.configurationUpdateHandler = { [weak self] cell, state in
      var visual = state
      visual.isSelected = self?.rowAppearsSelected(row) ?? false
      cell.backgroundConfiguration = LodySidebarCellBackground.configuration(for: visual)
      cell.accessibilityTraits = project ? [.button, .header] : .button
      if visual.isSelected { cell.accessibilityTraits.insert(.selected) }
    }
    cell.setNeedsUpdateConfiguration()
  }

  private func row(at index: IndexPath) -> LodyListRow? {
    dataSource.itemIdentifier(for: index).flatMap { rows[$0] }
  }

  func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool {
    row(at: indexPath)?.action == true
  }

  func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    row(at: indexPath)?.action == true
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    guard let row = row(at: indexPath) else { return }
    if row.parent && !row.navigates {
      collectionView.deselectItem(at: indexPath, animated: false)
      toggleOutline(row.id)
      return
    }
    unreadHold.begin(
      rowID: row.id,
      unread: row.unread,
      coversList: (row.preview == "session" || row.navigates)
        && (scrollOwner?.splitViewController?.isCollapsed ?? true)
    )
    if row.preview == "session" {
      setSelectedRowId(row.id)
    } else if row.navigates {
      collectionView.selectItem(at: indexPath, animated: true, scrollPosition: [])
      updateVisibleRows()
    } else {
      collectionView.deselectItem(at: indexPath, animated: true)
    }
    onRowPress(["id": row.id])
  }

  private func deselectOnReturn(animated: Bool, coordinator: UIViewControllerTransitionCoordinator?) {
    guard let index = collection.indexPathsForSelectedItems?.first else { return }
    guard let row = row(at: index), row.navigates, row.preview != "session" else { return }
    let id = row.id
    guard let coordinator else {
      collection.deselectItem(at: index, animated: animated)
      synchronizeSelection()
      updateVisibleRows()
      return
    }
    let started = coordinator.animate(alongsideTransition: { [weak self] _ in
      guard let self, let current = self.indexPath(for: id) else { return }
      self.collection.deselectItem(at: current, animated: animated)
      self.synchronizeSelection()
      self.updateVisibleRows()
    }, completion: { [weak self] context in
      guard context.isCancelled, let self, let current = self.indexPath(for: id) else { return }
      self.collection.selectItem(at: current, animated: false, scrollPosition: [])
      self.updateVisibleRows()
    })
    if !started {
      collection.deselectItem(at: index, animated: animated)
      synchronizeSelection()
      updateVisibleRows()
    }
  }

  private func swipes(at index: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
    guard let row = row(at: index) else { return nil }
    return LodyListRowInteractions.swipes(row: row, leading: leading) { [weak self] id, actionId in
      self?.onRowAction(["id": id, "actionId": actionId])
    }
  }

  private func menu(at index: IndexPath) -> UIContextMenuConfiguration? {
    guard let row = row(at: index) else { return nil }
    return LodyListRowInteractions.menu(row: row, userId: previewUserId, workspaceId: previewWorkspaceId) { [weak self] id, actionId in
      self?.onRowAction(["id": id, "actionId": actionId])
    }
  }

  func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint) -> UIContextMenuConfiguration? {
    indexPaths.first.flatMap { menu(at: $0) }
  }

  func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
    menu(at: indexPath)
  }

  func collectionView(_ collectionView: UICollectionView, willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionCommitAnimating) {
    guard let id = configuration.identifier as? String else { return }
    animator.addCompletion { [weak self] in
      let target = id.hasPrefix("toggle:") ? "project:" + String(id.dropFirst(7)) : id
      self?.onRowPress(["id": target])
    }
  }
}
