import LodyDesignSystem
import SwiftUI
import UIKit

// The iPhone Home list in the mobile design language. Reference design:
// the native mobile chat-list layout.
//
// It renders the same `InboxSections` projection as the other list hosts and emits
// the same `rowPress` / `rowAction` events, so `InboxController` keeps owning state,
// preferences and actions. Status replaces the trailing age when a chat needs
// attention; collapsed groups show their count and most urgent
// state. Cells are UIKit list cells (selection, swipe actions, context menus) whose
// content is SwiftUI on design-system tokens.
@MainActor
final class ChatListView: UIView, UICollectionViewDelegate {
  private enum Kind { case header, link, session, more }

  private struct Item: Hashable {
    let section: String
    let row: String
  }

  private struct Entry {
    let kind: Kind
    let row: LodyListRow
    /// nil when the group cannot collapse.
    let expanded: Bool?
    let canToggle: Bool
  }

  var forwarded: ((String, [String: Any]) -> Void)?
  private(set) var collection: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<String, Item>!
  private var entries: [Item: Entry] = [:]
  private var titles: [String: String] = [:]
  private let placeholder = UILabel()
  private let topBackdrop = ChatHeaderBackdrop()
  private var placeholderText = ""
  var owners: [String: WorkspaceMember] = [:] { didSet { if owners != oldValue { detailsChanged() } } }
  private var details = ChatRowDetails.stored
  /// The last projection, re-applied when an opener folds or unfolds.
  private var lastSections: [LodyListSection] = []
  /// Openers whose nested chats are hidden; default unfolded, as on web. Stored per device.
  private var foldedOpeners = Set(UserDefaults.standard.stringArray(forKey: ChatListView.foldedKey) ?? [])
  private static let foldedKey = "homeFoldedOpeners"
  /// UIKit owns a single section header and its push-off at the next section.
  /// Search labels remain in the flow.
  var pinsGroupLabels = true {
    didSet {
      guard pinsGroupLabels != oldValue else { return }
      collection.collectionViewLayout.invalidateLayout()
      updateBackdrop()
    }
  }
  var projectIndexEnabled = false {
    didSet {
      guard projectIndexEnabled != oldValue else { return }
      projectIndex.cancel()
      rebuildProjectIndex()
    }
  }
  /// Archived mode: a darker, greyer page and grey titles, so the archive never reads as the inbox.
  var archivedStyle = false {
    didSet {
      guard archivedStyle != oldValue else { return }
      backgroundColor = archivedStyle ? LodyUIColor.bgArchived : LodyUIColor.bgBase
      topBackdrop.archived = archivedStyle
      var snapshot = dataSource.snapshot()
      snapshot.reconfigureItems(snapshot.itemIdentifiers)
      dataSource.apply(snapshot, animatingDifferences: false)
    }
  }
  private lazy var projectIndex = InboxProjectIndex(scroll: collection)
  private var applyingSections = false
  private var sectionGeneration = 0
  private var detailsObserver: NSObjectProtocol?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = LodyUIColor.bgBase
    var config = UICollectionLayoutListConfiguration(appearance: .plain)
    config.showsSeparators = false
    config.backgroundColor = .clear
    config.headerMode = .supplementary
    config.headerTopPadding = 0
    config.trailingSwipeActionsConfigurationProvider = { [weak self] path in self?.swipe(path, leading: false) }
    config.leadingSwipeActionsConfigurationProvider = { [weak self] path in self?.swipe(path, leading: true) }
    let layout = UICollectionViewCompositionalLayout { [weak self] index, environment in
      let id = self?.dataSource?.sectionIdentifier(for: index)
      let title = id.flatMap { self?.titles[$0] } ?? ""
      var sectionConfig = config
      // Untitled first sections start at the navigation safe area without a blank header.
      if index == 0 && title.isEmpty { sectionConfig.headerMode = .none }
      let section = NSCollectionLayoutSection.list(using: sectionConfig, layoutEnvironment: environment)
      section.interGroupSpacing = 0
      section.boundarySupplementaryItems.forEach {
        $0.pinToVisibleBounds = self?.pinsGroupLabels == true && !title.isEmpty
        $0.zIndex = 2
      }
      return section
    }
    // Group spacing belongs between sections, not inside the pinned label.
    let layoutConfiguration = UICollectionViewCompositionalLayoutConfiguration()
    layoutConfiguration.interSectionSpacing = LodySpacing.md
    layout.configuration = layoutConfiguration
    let collection = ChatListCollectionView(frame: bounds, collectionViewLayout: layout)
    collection.onLayout = { [weak self] in
      self?.updateBackdrop()
      self?.refreshProjectIndex()
    }
    self.collection = collection
    collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collection.backgroundColor = .clear
    collection.delegate = self
    collection.accessibilityIdentifier = "home-chat-list"
    addSubview(collection)
    topBackdrop.layer.zPosition = 1
    topBackdrop.isHidden = true
    collection.addSubview(topBackdrop)
    let cell = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { [weak self] cell, _, item in
      self?.configure(cell, item)
    }
    let header = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
      elementKind: UICollectionView.elementKindSectionHeader
    ) { [weak self] view, _, path in
      let title = self?.dataSource.sectionIdentifier(for: path.section).flatMap { self?.titles[$0] } ?? ""
      view.contentConfiguration = UIHostingConfiguration {
        SectionTitle(text: title)
      }
      .margins(.all, 0)
      view.backgroundConfiguration = .clear()
      view.layer.zPosition = 2
    }
    dataSource = UICollectionViewDiffableDataSource(collectionView: collection) { view, path, item in
      view.dequeueConfiguredReusableCell(using: cell, for: path, item: item)
    }
    dataSource.supplementaryViewProvider = { view, _, path in
      view.dequeueConfiguredReusableSupplementary(using: header, for: path)
    }

    placeholder.font = LodyTextStyle.body.uiFont
    placeholder.textColor = LodyUIColor.textSecondary
    placeholder.textAlignment = .center
    placeholder.numberOfLines = 0
    placeholder.adjustsFontForContentSizeCategory = true
    placeholder.isHidden = true
    addSubview(placeholder)
    projectIndex.accessibilityLabel = String(localized: "inbox.projectIndex.accessibility", bundle: .lody)
    projectIndex.accessibilityHint = String(localized: "inbox.projectIndex.hint", bundle: .lody)
    projectIndex.jump = { [weak self] in self?.jumpToSection($0) }
    addSubview(projectIndex)
    detailsObserver = NotificationCenter.default.addObserver(forName: .lodyChatRowDetailsChanged, object: nil, queue: .main) {
      [weak self] _ in MainActor.assumeIsolated { self?.detailsChanged() }
    }
  }

  isolated deinit {
    if let detailsObserver { NotificationCenter.default.removeObserver(detailsObserver) }
  }

  /// The view menu changed which details rows show: re-render visible rows in place.
  private func detailsChanged() {
    details = ChatRowDetails.stored
    var snapshot = dataSource.snapshot()
    snapshot.reconfigureItems(snapshot.itemIdentifiers.filter { entries[$0]?.kind == .session })
    dataSource.apply(snapshot, animatingDifferences: false)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func layoutSubviews() {
    super.layoutSubviews()
    if projectIndex.frame.size != bounds.size { projectIndex.cancel() }
    collection.frame = bounds
    projectIndex.frame = bounds
    refreshProjectIndex()
    updateBackdrop()
    let inset = LodyLayout.listEdgeX * 2
    placeholder.frame = CGRect(x: inset, y: bounds.midY - 60, width: max(0, bounds.width - inset * 2), height: 120)
  }

  func setPlaceholder(_ value: String) {
    placeholderText = value
    updatePlaceholder()
  }

  func setSections(_ sections: [LodyListSection]) {
    projectIndex.cancel()
    projectIndex.update([])
    applyingSections = true
    sectionGeneration += 1
    let generation = sectionGeneration
    lastSections = sections
    var snapshot = NSDiffableDataSourceSnapshot<String, Item>()
    var next: [Item: Entry] = [:]
    var nextTitles: [String: String] = [:]
    for section in sections where !section.rows.isEmpty {
      snapshot.appendSections([section.id])
      // Only flat sections (inbox buckets, search) carry a text header; groups use their parent row.
      nextTitles[section.id] = section.rows.first?.parent == true ? "" : section.header
      let children = section.rows.contains { !$0.parent }
      for row in section.rows {
        let item = Item(section: section.id, row: row.id)
        let entry: Entry
        if row.parent {
          entry = Entry(kind: .header, row: row, expanded: section.headerExpanded, canToggle: section.headerExpanded != nil && children)
        } else if section.headerExpanded == false {
          continue
        } else if row.image == "folder" {
          entry = Entry(kind: .link, row: row, expanded: nil, canToggle: false)
        } else if row.id.hasPrefix("project:") || row.id.hasPrefix("view:") {
          entry = Entry(kind: .more, row: row, expanded: nil, canToggle: false)
        } else if !row.parentId.isEmpty, foldedOpeners.contains(row.parentId) {
          continue
        } else if row.treeParent {
          // The parent keeps its own state; hidden children have a separate summary.
          let open = !foldedOpeners.contains(row.id)
          entry = Entry(kind: .session, row: row, expanded: open, canToggle: true)
        } else {
          entry = Entry(kind: .session, row: row, expanded: nil, canToggle: false)
        }
        guard next[item] == nil else { continue }
        next[item] = entry
        snapshot.appendItems([item], toSection: section.id)
      }
    }
    let changed = Set(next.keys).filter { key in entries[key].map { !Self.same($0.row, next[key]!.row, $0.expanded, next[key]!.expanded) } ?? false }
    // Recreate cells when commands change to discard the previous swipe presentation.
    let actionsChanged = Set(next.keys).filter { key in
      guard let old = entries[key], let new = next[key] else { return false }
      return old.row.actions != new.row.actions || old.row.leadingActions != new.row.leadingActions
    }
    entries = next
    titles = nextTitles
    snapshot.reloadItems(Array(actionsChanged))
    snapshot.reconfigureItems(Array(changed.subtracting(actionsChanged)))
    dataSource.apply(snapshot, animatingDifferences: window != nil && !UIAccessibility.isReduceMotionEnabled) { [weak self] in
      guard let self, self.sectionGeneration == generation else { return }
      self.applyingSections = false
      self.updateBackdrop()
      self.rebuildProjectIndex()
    }
    updateBackdrop()
    updatePlaceholder()
  }

  private func rebuildProjectIndex() {
    guard !applyingSections else { return }
    let snapshot = dataSource.snapshot()
    let sections = Dictionary(lastSections.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    let items: [InboxProjectIndex.Item] = projectIndexEnabled ? snapshot.sectionIdentifiers.compactMap { id in
      guard let section = sections[id], snapshot.numberOfItems(inSection: id) > 0 else { return nil }
      let tints = section.rows.flatMap { [$0.imageTint, $0.collapsedImageTint] }
      let tint = ["danger", "warning", "blue"].first(where: tints.contains)
        ?? (section.rows.contains(where: \.unread) ? "blue" : "")
      let symbol = ["pinned": "pin.fill", "group:chat": "bubble.left" ][id] ?? ""
      // HomeRows preserves raw repository identity even when grouping hides row.place.
      // Use the root, never a cross-project opened child or Pinned's first row.
      let repository = section.rows.first?.repository ?? ""
      let image = symbol.isEmpty ? RepositoryImages.url(repository)?.absoluteString ?? "" : ""
      return InboxProjectIndex.Item(id: id, title: section.header, symbol: symbol, tint: tint, image: image)
    } : []
    projectIndex.update(items)
    collection.showsVerticalScrollIndicator = items.count < 2
    refreshProjectIndex()
  }

  private func refreshProjectIndex() {
    guard !applyingSections else { return }
    let top = collection.contentOffset.y + collection.adjustedContentInset.top
    let path = collection.indexPathsForVisibleItems.filter { path in
      (collection.layoutAttributesForItem(at: path)?.frame.maxY ?? 0) > top
    }.min()
    let id = path.flatMap { dataSource.itemIdentifier(for: $0)?.section }
    projectIndex.refresh(current: id)
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    refreshProjectIndex()
    projectIndex.setScrolling(true)
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { projectIndex.setScrolling(false) }
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    projectIndex.setScrolling(false)
  }

  private func jumpToSection(_ id: String) {
    guard projectIndexEnabled, !applyingSections else { return }
    let snapshot = dataSource.snapshot()
    guard snapshot.sectionIdentifiers.contains(id), let item = snapshot.itemIdentifiers(inSection: id).first,
      let path = dataSource.indexPath(for: item),
      let attributes = collection.layoutAttributesForItem(at: path) else { return }
    // Item geometry is unpinned and belongs to the committed snapshot. Never query
    // supplementary attributes with a path retained across a diffable update.
    let headerHeight = collection.collectionViewLayout.layoutAttributesForSupplementaryView(
      ofKind: UICollectionView.elementKindSectionHeader, at: IndexPath(item: 0, section: path.section)
    )?.frame.height ?? 0
    let lower = -collection.adjustedContentInset.top
    let upper = max(lower, collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
    let y = min(upper, max(lower, attributes.frame.minY - headerHeight - collection.adjustedContentInset.top))
    collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: y), animated: false)
    collection.layoutIfNeeded()
  }

  private func toggleOpener(_ id: String) {
    if foldedOpeners.remove(id) == nil { foldedOpeners.insert(id) }
    UserDefaults.standard.set(Array(foldedOpeners).sorted(), forKey: Self.foldedKey)
    setSections(lastSections)
  }

  /// One continuous backdrop runs from the pinned label to the window top.
  /// Keep UIKit's original supplementary label, including its native push-off.
  private func updateBackdrop() {
    let top = collection.contentOffset.y + collection.adjustedContentInset.top
    // At rest the first label already sits at the top edge; it only counts as pinned (and
    // brings the blur) once content has actually scrolled under it.
    let scrolled = top > 0.5
    // During a diffable update UIKit can still display headers from the old snapshot.
    // Their index paths are not valid in the new layout. Read the actual visible views'
    // frames instead of asking UICollectionView to resolve transitional index paths.
    let headers = collection.visibleSupplementaryViews(ofKind: UICollectionView.elementKindSectionHeader)
    let active = headers.filter { header in
      pinsGroupLabels && scrolled && header.frame.minY <= top + 1
    }.max { $0.frame.minY < $1.frame.minY }
    // A departing header falls behind the continuous backdrop as it moves above the slot.
    for header in headers {
      header.layer.zPosition = pinsGroupLabels && header.frame.minY < top - 1 ? 0 : 2
    }
    // A second system edge would introduce a seam in the middle of the gradient.
    collection.topEdgeEffect.isHidden = active != nil
    topBackdrop.isHidden = active == nil
    if let header = active {
      topBackdrop.frame = CGRect(x: collection.bounds.minX, y: collection.bounds.minY,
                                width: collection.bounds.width,
                                height: collection.adjustedContentInset.top + header.frame.height + LodySpacing.xxl)
    }
  }

  private static func same(_ a: LodyListRow, _ b: LodyListRow, _ ea: Bool?, _ eb: Bool?) -> Bool {
    a.title == b.title && a.subtitle == b.subtitle && a.unread == b.unread && a.imageTint == b.imageTint
      && a.value == b.value && a.place == b.place && a.placeIsRepo == b.placeIsRepo && a.repository == b.repository && a.branch == b.branch && a.prStatus == b.prStatus && a.prCI == b.prCI
      && a.collapsedImageTint == b.collapsedImageTint && a.collapsedBadge == b.collapsedBadge
      && a.badge == b.badge && a.pinned == b.pinned && a.parentId == b.parentId && a.lastChild == b.lastChild && a.treeParent == b.treeParent && a.childCount == b.childCount && a.highlight == b.highlight && ea == eb
  }

  private func updatePlaceholder() {
    placeholder.text = placeholderText
    placeholder.isHidden = !entries.isEmpty || placeholderText.isEmpty
  }

  // MARK: Cells

  private func configure(_ cell: UICollectionViewListCell, _ item: Item) {
    guard let entry = entries[item] else { return }
    let muted = archivedStyle
    let emit: (String) -> Void = { [weak self] action in
      self?.forwarded?("rowAction", ["id": entry.row.id, "actionId": action])
    }
    cell.contentConfiguration = UIHostingConfiguration {
      switch entry.kind {
      case .header: GroupHeader(row: entry.row, expanded: entry.expanded, canToggle: entry.canToggle, onAction: emit)
      case .link: GroupHeader(row: entry.row, expanded: nil, canToggle: false, onAction: emit)
      case .session:
        ChatRowContent(
          row: entry.row, details: details, owner: owners[entry.row.id], muted: muted,
          expanded: entry.canToggle ? entry.expanded : nil,
          onToggle: { [weak self] in self?.toggleOpener(entry.row.id) }
        )
      case .more: MoreRowContent(title: entry.row.title)
      }
    }
    .margins(.all, 0)
    .minSize(height: entry.kind == .session && !entry.row.parentId.isEmpty ? LodySize.controlMd : LodySize.listRow)
    cell.accessories = []
    // iOS highlights rows on press; Android uses ripple.
    // The archived page is already as grey as fill.pressed, so it highlights with a translucent fill.
    let pressed = archivedStyle ? LodyUIColor.fillSelected : LodyUIColor.fillPressed
    cell.configurationUpdateHandler = { cell, state in
      var background = UIBackgroundConfiguration.clear()
      background.backgroundColor = state.isHighlighted || state.isSelected ? pressed : .clear
      cell.backgroundConfiguration = background
    }
  }

  // MARK: Interaction

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let item = dataSource.itemIdentifier(for: indexPath), let entry = entries[item] else { return }
    if entry.kind == .header, entry.canToggle, let expanded = entry.expanded {
      forwarded?("rowPress", ["id": entry.row.id, "expanded": !expanded])
    } else {
      forwarded?("rowPress", ["id": entry.row.id])
    }
  }

  private func swipe(_ path: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
    guard let item = dataSource.itemIdentifier(for: path), let entry = entries[item], entry.kind == .session else { return nil }
    let actions = (leading ? entry.row.leadingActions : entry.row.actions).map { action in
      let contextual = UIContextualAction(style: action.destructive ? .destructive : .normal, title: action.title) { [weak self] _, _, done in
        self?.forwarded?("rowAction", ["id": entry.row.id, "actionId": action.id])
        done(true)
      }
      contextual.image = UIImage(systemName: action.symbol)
      if !action.destructive { contextual.backgroundColor = Self.swipeTint(action.tint) }
      return contextual
    }
    guard !actions.isEmpty else { return nil }
    let config = UISwipeActionsConfiguration(actions: actions)
    config.performsFirstActionWithFullSwipe = false
    return config
  }

  private static func swipeTint(_ tint: String) -> UIColor {
    tint == "yellow" ? .systemYellow : LodyUIColor.accentSolid
  }

  func collectionView(
    _ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let path = indexPaths.first, let item = dataSource.itemIdentifier(for: path), let entry = entries[item],
      !entry.row.menuActions.isEmpty
    else { return nil }
    let row = entry.row
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      UIMenu(children: row.menuActions.map { action in
        UIAction(
          title: action.title, image: UIImage(systemName: action.symbol),
          attributes: action.destructive ? .destructive : []
        ) { _ in self?.forwarded?("rowAction", ["id": row.id, "actionId": action.id]) }
      })
    }
  }
}

/// Keep a blurred base under the upper gradient: fading a single blur view mixes
/// sharp source text back in. Only the tail below the label fades to clear.
private final class ChatHeaderBackdrop: UIView {
  private let base = ChatBlurLayer(intensity: 0.2)
  private let upper = ChatBlurLayer(intensity: 0.75)
  var archived = false { didSet { if archived != oldValue { updateTone() } } }

  init() {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    addSubview(base)
    addSubview(upper)
    updateTone()
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: ChatHeaderBackdrop, _: UITraitCollection) in
      view.updateTone()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private func updateTone() {
    let dark = traitCollection.userInterfaceStyle == .dark
    // Dark mode keeps its page tint; light mode tints only the archived page's grey.
    let page = archived ? LodyUIColor.bgArchived : LodyUIColor.bgBase
    let (baseAlpha, upperAlpha): (CGFloat, CGFloat) = if dark {
      (0.1, 0.3)
    } else if archived {
      (0.3, 0.6)
    } else {
      (0, 0)
    }
    base.contentView.backgroundColor = baseAlpha > 0 ? page.withAlphaComponent(baseAlpha) : .clear
    upper.contentView.backgroundColor = upperAlpha > 0 ? page.withAlphaComponent(upperAlpha) : .clear
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    base.frame = bounds
    upper.frame = bounds
    let labelEnd = max(0, min(1, (bounds.height - LodySpacing.xxl) / max(1, bounds.height)))
    base.setFade(colors: [1, 0.85, 0], locations: [0, labelEnd, 1])
    upper.setFade(colors: [1, 0, 0], locations: [0, labelEnd, 1])
  }
}

private final class ChatBlurLayer: UIVisualEffectView {
  private let fadeView = ChatBlurMask()
  private var animator: UIViewPropertyAnimator?
  private var lastSize = CGSize.zero
  private var lastLocations: [CGFloat] = []

  init(intensity: CGFloat) {
    super.init(effect: nil)
    let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) { [weak self] in
      self?.effect = UIBlurEffect(style: .regular)
    }
    animator.pausesOnCompletion = true
    animator.fractionComplete = intensity
    self.animator = animator
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { animator?.stopAnimation(true) }

  func setFade(colors: [CGFloat], locations: [CGFloat]) {
    guard lastSize != bounds.size || lastLocations != locations else { return }
    lastSize = bounds.size
    lastLocations = locations
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    fadeView.frame = bounds
    let gradient = fadeView.layer as! CAGradientLayer
    gradient.colors = colors.map { UIColor.black.withAlphaComponent($0).cgColor }
    gradient.locations = locations.map { NSNumber(value: Double($0)) }
    mask = nil
    mask = fadeView
    CATransaction.commit()
  }
}

private final class ChatBlurMask: UIView {
  override class var layerClass: AnyClass { CAGradientLayer.self }
}

// MARK: - Content

/// The status mark a chat shows, matching the web `SessionRowStatusIndicator` and its priority:
/// failed (circle alert, danger) > waiting for permission (hand) > working (grid) > unread (dot).
/// Idle and done chats show nothing. Shared with the conversation's Tabs panel.
enum Attention {
  case failed, waiting, working, unread

  /// A session's mark, as its row in the Chats list shows it.
  init?(_ session: SessionItem) {
    self.init(tint: SessionState(session).tint, unread: SessionRows.needsEmphasis(session))
  }

  init?(tint: String, unread: Bool) {
    switch tint {
    case "danger": self = .failed
    case "warning": self = .waiting
    case "blue": self = .working
    default:
      guard unread else { return nil }
      self = .unread
    }
  }

  /// The web draws a 12 px mark in a 14 px box beside 14 px text.
  static let size = LodyIconSize.xs + LodySpacing.xxs
}

private struct Glyph: View {
  let icon: LodyIcon
  var size: CGFloat = LodyIconSize.md
  var color: Color = LodyColor.iconPrimary

  var body: some View {
    icon.image.resizable().renderingMode(.template).foregroundStyle(color).frame(width: size, height: size)
  }
}

struct AttentionGlyph: View {
  let attention: Attention

  var body: some View {
    switch attention {
    case .failed: Glyph(icon: .alert, size: Attention.size, color: LodyColor.dangerDefault)
    case .waiting: Glyph(icon: .hand, size: Attention.size, color: LodyColor.accentDefault)
    case .working: LodyWorkingGrid(size: Attention.size, color: LodyColor.accentDefault)
    case .unread: Circle().fill(LodyColor.accentDefault).frame(width: LodySize.dot, height: LodySize.dot)
    }
  }
}

private struct GroupHeader: View {
  let row: LodyListRow
  let expanded: Bool?
  let canToggle: Bool
  let onAction: (String) -> Void

  private var icon: LodyIcon {
    switch row.image {
    case "bubble.left": .session
    case "pin.fill": .pin
    default: .folder
    }
  }

  /// The group's own new-chat action, surfaced as the trailing button.
  private var compose: LodyListAction? {
    row.menuActions.first { $0.id == "newSession" || $0.id == "newChat" }
  }

  var body: some View {
    HStack(spacing: LodyLayout.listRowGap) {
      Glyph(icon: icon)
      Text(row.title)
        .lodyTextStyle(.groupLabel)
        .foregroundStyle(LodyColor.textTertiary)
        .lineLimit(1)
      Spacer(minLength: LodySpacing.sm)
      if expanded == false || !canToggle, !row.badge.isEmpty, row.badge != "0" {
        if let attention = Attention(tint: row.imageTint, unread: false) { AttentionGlyph(attention: attention) }
        Text(row.badge)
          .lodyTextStyle(.footnote)
          .foregroundStyle(LodyColor.textTertiary)
          .monospacedDigit()
      }
      if let compose {
        Button { onAction(compose.id) } label: { Glyph(icon: .compose, color: LodyColor.iconSecondary) }
          .buttonStyle(.borderless)
          .frame(width: LodySize.touchTarget, height: LodySize.touchTarget)
          .accessibilityLabel(compose.title)
      } else {
        Color.clear.frame(width: LodySpacing.xs, height: 1)
      }
    }
    .padding(.leading, LodyLayout.listEdgeX)
    .padding(.trailing, LodySpacing.xs)
    .frame(maxWidth: .infinity, minHeight: LodySize.listRow, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isHeader)
    .accessibilityValue(accessibilityValue)
  }

  private var accessibilityValue: String {
    guard canToggle, let expanded else { return row.badge }
    if expanded { return String(localized: "native.list.expanded", bundle: .lody) }
    let state = String(localized: "native.list.collapsed", bundle: .lody)
    return [state, row.badge].filter { !$0.isEmpty }.joined(separator: ", ")
  }
}

/// Which details a chat row's second line shows. Chosen from the Home view menu and persisted;
/// with none selected (or nothing to show for a row) the row is a single title line.
struct ChatRowDetails: OptionSet, Sendable {
  let rawValue: Int
  static let project = ChatRowDetails(rawValue: 1 << 0)
  static let pullRequest = ChatRowDetails(rawValue: 1 << 1)
  static let branch = ChatRowDetails(rawValue: 1 << 2)
  static let defaults: ChatRowDetails = [.project, .pullRequest]

  private static let key = "homeChatRowDetails"

  static var stored: ChatRowDetails {
    guard UserDefaults.standard.object(forKey: key) != nil else { return defaults }
    return ChatRowDetails(rawValue: UserDefaults.standard.integer(forKey: key))
  }

  static func store(_ value: ChatRowDetails) {
    UserDefaults.standard.set(value.rawValue, forKey: key)
    NotificationCenter.default.post(name: .lodyChatRowDetailsChanged, object: nil)
  }
}

extension Notification.Name {
  static let lodyChatRowDetailsChanged = Notification.Name("LodyChatRowDetailsChanged")
}

/// Line 1: title · status or updated time. Line 2 (aligned with the title): folder or
/// repository mark · project · branch, with the pull request mark trailing.
private struct ChatRowContent: View {
  let row: LodyListRow
  let details: ChatRowDetails
  var owner: WorkspaceMember?
  /// Archived list: the title drops to grey ink so every row reads as archived.
  var muted = false
  /// Set on a row with nested chats: whether they are shown. A "⌄ 4 opened chats" line below the
  /// row heads the family; both parent and child status marks stay trailing.
  var expanded: Bool?
  var onToggle: () -> Void = {}

  private var project: String { details.contains(.project) ? row.place : "" }
  private var branch: String { details.contains(.branch) ? row.branch : "" }
  private var pullRequest: PullRequestMark? { details.contains(.pullRequest) ? PullRequestMark(row.prStatus, ci: row.prCI) : nil }
  /// The detail line needs a project or branch; a PR mark alone stays on the title line, before the age.
  private var hasDetailLine: Bool { !project.isEmpty || !branch.isEmpty }
  private var inlinePullRequest: PullRequestMark? { attention == nil && (snippet != nil || !hasDetailLine) ? pullRequest : nil }

  private var attention: Attention? { Attention(tint: row.imageTint, unread: row.unread) }
  private var nested: Bool { !row.parentId.isEmpty }

  /// Search results keep their match snippet in place of the detail line.
  private var snippet: String? {
    row.wrapSubtitle && !row.subtitle.isEmpty ? row.subtitle : nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      content
      if let expanded { familyToggle(expanded) }
    }
    .backgroundPreferenceValue(ChatRowTitleBounds.self) { anchor in
      GeometryReader { geometry in
        if nested, let anchor {
          let turn = geometry[anchor].midY
          Path { path in
            let fork = max(0, turn - LodySpacing.md)
            path.move(to: CGPoint(x: Self.railX, y: 0))
            path.addLine(to: CGPoint(x: Self.railX, y: fork))
            path.addCurve(to: CGPoint(x: ChatRowContent.childIndent - LodySpacing.sm, y: turn),
              control1: CGPoint(x: Self.railX, y: turn - LodyRadius.sm),
              control2: CGPoint(x: Self.railX + LodySpacing.xs, y: turn))
            if !row.lastChild {
              path.move(to: CGPoint(x: Self.railX, y: fork))
              path.addLine(to: CGPoint(x: Self.railX, y: geometry.size.height))
            }
          }
          .stroke(LodyColor.borderDefault, style: StrokeStyle(lineWidth: Self.railWidth, lineCap: .round, lineJoin: .round))
        }
      }
      .allowsHitTesting(false)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel([owner?.name, row.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
    .accessibilityValue(
      [row.badge, project, branch, pullRequest?.label ?? "", familyLabel, row.accessibilityValue].filter { !$0.isEmpty }.joined(separator: ", ")
    )
    .accessibilityAddTraits(.isButton)
    .accessibilityActions {
      if let expanded {
        Button(String(localized: String.LocalizationValue(expanded ? "home.tree.collapse" : "home.tree.expand"), bundle: .lody), action: onToggle)
      }
    }
  }

  private var content: some View {
    HStack(alignment: .center, spacing: 0) {
      if nested { Color.clear.frame(width: Self.childLevel, height: 1) }
      VStack(alignment: .leading, spacing: LodySpacing.xxs) {
        HStack(alignment: .center, spacing: LodySpacing.sm) {
          Text(row.title)
            .lodyTextStyle(nested ? .callout : row.unread ? .bodyEmphasis : .body)
            .fontWeight(nested && row.unread ? .semibold : nil)
            .foregroundStyle(muted ? LodyColor.textTertiary : LodyColor.textPrimary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
          // The text inside sets the stack's baseline, so the PR mark centres on the age.
          if let attention {
            AttentionGlyph(attention: attention).frame(width: LodyIconSize.md, height: LodyIconSize.md)
          } else if inlinePullRequest != nil || !row.value.isEmpty {
            HStack(spacing: LodySpacing.xs) {
              inlinePullRequest?.glyph
              if !row.value.isEmpty {
                Text(row.value)
                  .lodyTextStyle(.footnote)
                  .foregroundStyle(LodyColor.textTertiary)
                  .monospacedDigit()
              }
            }
            .fixedSize()
          }
          if let owner { ChatOwnerAvatar(member: owner) }
        }
        .anchorPreference(key: ChatRowTitleBounds.self, value: .bounds) { $0 }
        if let snippet {
          Text(snippet).lodyTextStyle(.footnote).foregroundStyle(LodyColor.textSecondary).lineLimit(2)
        } else if hasDetailLine {
          detailLine
        }
      }
    }
    .padding(.horizontal, LodyLayout.listEdgeX)
    .padding(.vertical, snippet != nil || hasDetailLine ? LodySpacing.sm : 0)
    .frame(maxWidth: .infinity, minHeight: nested ? LodySize.controlMd : LodySize.listRow, alignment: .leading)
  }

  /// Child count and expanded state for VoiceOver; the toggle is an accessibility action.
  private var familyLabel: String {
    guard let expanded else { return "" }
    let count = String.localizedStringWithFormat(String(localized: "home.tree.count", bundle: .lody), row.childCount)
    let state = String(localized: String.LocalizationValue(expanded ? "home.tree.expanded" : "home.tree.collapsed"), bundle: .lody)
    return count + ", " + state
  }

  /// The family chevron sits at the opener's title edge; the rail runs down its centre.
  private static let chevronSize = LodyIconSize.xs
  private static let railWidth = LodySpacing.xxs / 2
  private static let railX = LodyLayout.listEdgeX + chevronSize / 2
  /// One nesting level: how far a child's title steps in.
  static let childLevel = LodyLayout.childIndent - LodyLayout.screenPaddingX
  /// A nested title's leading edge: the list edge plus one level.
  static let childIndent = LodyLayout.listEdgeX + childLevel

  /// The whole family line toggles its children; the opener above still opens the chat.
  private func familyToggle(_ expanded: Bool) -> some View {
    Button(action: onToggle) {
      HStack(spacing: LodySpacing.xs) {
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(LodyColor.iconSecondary)
          .frame(width: Self.chevronSize, height: Self.chevronSize)
          .rotationEffect(.degrees(expanded ? 90 : 0))
          .animation(LodySpring.snappy, value: expanded)
        Text(String.localizedStringWithFormat(String(localized: "home.tree.count", bundle: .lody), row.childCount))
          .lodyTextStyle(.footnote)
          .foregroundStyle(LodyColor.textSecondary)
          .monospacedDigit()
        Spacer(minLength: LodySpacing.sm)
        if !expanded, let status = Attention(tint: row.collapsedImageTint, unread: false) {
          AttentionGlyph(attention: status)
            .frame(width: LodyIconSize.md, height: LodyIconSize.md)
        }
      }
      .padding(.horizontal, LodyLayout.listEdgeX)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHidden(true)
  }

  private var detailLine: some View {
    HStack(spacing: LodySpacing.xs) {
      if !project.isEmpty {
        if row.placeIsRepo {
          RepositoryIcon(repository: row.repository)
        } else {
          Glyph(icon: .folder, size: LodyIconSize.sm, color: LodyColor.iconSecondary)
        }
        Text(project).lodyTextStyle(.footnote).foregroundStyle(LodyColor.textSecondary).lineLimit(1)
      }
      if !branch.isEmpty {
        Glyph(icon: .branch, size: LodyIconSize.sm, color: LodyColor.iconTertiary)
          .padding(.leading, project.isEmpty ? 0 : LodySpacing.xs)
        Text(branch).lodyTextStyle(.footnote).foregroundStyle(LodyColor.textTertiary).lineLimit(1).truncationMode(.middle)
      }
      Spacer(minLength: LodySpacing.sm)
      pullRequest?.glyph
    }
    .frame(maxWidth: .infinity)
  }
}

private struct ChatRowTitleBounds: PreferenceKey {
  static var defaultValue: Anchor<CGRect>? { nil }
  static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
    value = nextValue() ?? value
  }
}

/// The web `SessionPrIcon` states: open, merged, closed, draft.
private struct PullRequestMark {
  let status: String
  let label: String
  let ci: PullRequestCI?

  var glyph: some View { LodyPullRequestIcon(status: status, ci: ci?.rawValue).fixedSize() }

  init?(_ status: String, ci: String = "") {
    guard ["open", "merged", "closed", "draft"].contains(status) else { return nil }
    self.status = status
    self.ci = PullRequestCI(rawValue: ci)
    let pr = String(localized: String.LocalizationValue("home.pr." + status), bundle: .lody)
    label = self.ci.map { pr + ", " + String(localized: String.LocalizationValue("home.ci." + $0.rawValue), bundle: .lody) } ?? pr
  }
}

private struct MoreRowContent: View {
  let title: String

  var body: some View {
    Text(title)
      .lodyTextStyle(.body)
      .foregroundStyle(LodyColor.textTertiary)
      .padding(.leading, ChatRowContent.childIndent)
      .frame(maxWidth: .infinity, minHeight: LodySize.listRow, alignment: .leading)
      .accessibilityAddTraits(.isButton)
  }
}

private struct SectionTitle: View {
  let text: String

  var body: some View {
    if text.isEmpty {
      Color.clear.frame(height: LodySpacing.sm)
    } else {
      Text(text)
        .lodyTextStyle(.groupLabel)
        .foregroundStyle(LodyColor.textTertiary)
        .padding(.horizontal, LodyLayout.listEdgeX)
        .padding(.top, LodySpacing.xs)
        .padding(.bottom, LodySpacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    }
  }
}

/// Compact person identity; shares the native image cache with message avatars.
struct ChatOwnerAvatar: View {
  let member: WorkspaceMember
  @State private var loaded: UIImage?
  @State private var loadedURL: URL?
  private var url: URL? { member.image.flatMap(URL.init(string:)) }
  private var initial: String { String(member.name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased() }
  var body: some View {
    Group {
      if let url, loadedURL == url, let loaded {
        Image(uiImage: loaded).resizable().scaledToFill()
      } else {
        Text(initial.isEmpty ? "?" : initial)
          .lodyTextStyle(.caption).foregroundStyle(LodyColor.textSecondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity).background(LodyColor.fillSecondary)
      }
    }
    .frame(width: LodyIconSize.md, height: LodyIconSize.md).clipShape(Circle())
    .accessibilityLabel(member.name)
    .task(id: url) {
      guard let url else { return }
      if let image = LodyListPhoto.image(for: url, shape: .original, ready: { image in
        loadedURL = url; loaded = image
      }) { loadedURL = url; loaded = image }
    }
  }
}
