import LodyDesignSystem
import SwiftUI
import UIKit

// The Home list in the mobile design language, on iPhone and in the iPad / iPhone Duo split. Reference design:
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
  /// Repository of each project group's label (project grouping), drawn as its logo.
  private var titleRepositories: [String: String] = [:]
  private let placeholder = UILabel()
  private let topBackdrop = LodyPinnedLabelBackdrop()
  private var placeholderText = ""
  var owners: [String: WorkspaceMember] = [:] { didSet { if owners != oldValue { detailsChanged() } } }
  private var details = ChatRowDetails.stored
  /// The last projection, re-applied when an opener folds or unfolds.
  private var lastSections: [LodyListSection] = []
  /// Openers whose nested chats are hidden; default unfolded, as on web. Stored per device.
  private var foldedOpeners = Set(UserDefaults.standard.stringArray(forKey: ChatListView.foldedKey) ?? [])
  private static let foldedKey = "homeFoldedOpeners"
  /// Home group labels the person collapsed; their headers stay, their rows leave the list.
  private let groupFolds = ChatGroupFolds()
  /// Whether the projection has any row, collapsed or not (the empty-state text hides otherwise).
  private var hasRows = false
  /// UIKit owns a single section header and its push-off at the next section.
  /// Search labels remain in the flow and never collapse.
  var pinsGroupLabels = true {
    didSet {
      guard pinsGroupLabels != oldValue else { return }
      groupFolds.enabled = pinsGroupLabels
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
      groupFolds.scope = archivedStyle ? "archived:" : ""
      var snapshot = dataSource.snapshot()
      snapshot.reconfigureItems(snapshot.itemIdentifiers)
      dataSource.apply(snapshot, animatingDifferences: false)
    }
  }
  /// The conversation shown beside the list (iPad and unfolded iPhone Duo split); it stays highlighted.
  var selectedRowId = "" {
    didSet {
      guard selectedRowId != oldValue else { return }
      var snapshot = dataSource.snapshot()
      let affected = snapshot.itemIdentifiers.filter { $0.row == selectedRowId || $0.row == oldValue }
      guard !affected.isEmpty else { return }
      snapshot.reconfigureItems(affected)
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
      let id = self?.dataSource.sectionIdentifier(for: path.section)
      let title = id.flatMap { self?.titles[$0] } ?? ""
      let repository = id.flatMap { self?.titleRepositories[$0] } ?? ""
      guard let folds = self?.groupFolds else { return }
      view.contentConfiguration = UIHostingConfiguration {
        SectionTitle(text: title, repository: repository, folds: folds, groupId: id ?? "") { [weak self] in
          if let id { self?.toggleGroup(id) }
        }
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
    hasRows = sections.contains { !$0.rows.isEmpty }
    var snapshot = NSDiffableDataSourceSnapshot<String, Item>()
    var next: [Item: Entry] = [:]
    var nextTitles: [String: String] = [:]
    var nextRepositories: [String: String] = [:]
    for section in sections where !section.rows.isEmpty {
      snapshot.appendSections([section.id])
      // Only flat sections (inbox buckets, search) carry a text header; groups use their parent row.
      nextTitles[section.id] = section.rows.first?.parent == true ? "" : section.header
      // Project grouping: the root row keeps its raw repository, never a cross-project child's.
      if section.id.hasPrefix("group:"), section.id != "group:\(InboxSections.chatId)",
         let repository = section.rows.first?.repository, !repository.isEmpty {
        nextRepositories[section.id] = repository
      }
      // A collapsed group keeps its label, which UIKit still lays out for an empty section.
      if !(nextTitles[section.id] ?? "").isEmpty, groupFolds.isCollapsed(section.id) { continue }
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
    titleRepositories = nextRepositories
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
      // Collapsed groups have no items but stay destinations through their label.
      guard let section = sections[id] else { return nil }
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
    guard let sectionIndex = snapshot.indexOfSection(id) else { return }
    // Item geometry is unpinned and belongs to the committed snapshot. Never query
    // supplementary attributes with a path retained across a diffable update.
    let header = collection.collectionViewLayout.layoutAttributesForSupplementaryView(
      ofKind: UICollectionView.elementKindSectionHeader, at: IndexPath(item: 0, section: sectionIndex)
    )
    let top: CGFloat
    if let item = snapshot.itemIdentifiers(inSection: id).first, let path = dataSource.indexPath(for: item),
       let attributes = collection.layoutAttributesForItem(at: path) {
      top = attributes.frame.minY - (header?.frame.height ?? 0)
    } else if let header, snapshot.numberOfItems(inSection: id) == 0 {
      // A collapsed group has only its label; with no rows below it the label is not pinned.
      top = header.frame.minY
    } else {
      return
    }
    let lower = -collection.adjustedContentInset.top
    let upper = max(lower, collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
    let y = min(upper, max(lower, top - collection.adjustedContentInset.top))
    collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: y), animated: false)
    collection.layoutIfNeeded()
  }

  private func toggleOpener(_ id: String) {
    if foldedOpeners.remove(id) == nil { foldedOpeners.insert(id) }
    UserDefaults.standard.set(Array(foldedOpeners).sorted(), forKey: Self.foldedKey)
    setSections(lastSections)
  }

  /// The label's chevron turns while the group's rows animate out of or into the list.
  private func toggleGroup(_ id: String) {
    groupFolds.toggle(id)
    setSections(lastSections)
  }

  private func updateBackdrop() {
    topBackdrop.update(in: collection, pinsLabels: pinsGroupLabels)
  }

  private static func same(_ a: LodyListRow, _ b: LodyListRow, _ ea: Bool?, _ eb: Bool?) -> Bool {
    a.title == b.title && a.subtitle == b.subtitle && a.unread == b.unread && a.imageTint == b.imageTint
      && a.value == b.value && a.place == b.place && a.placeIsRepo == b.placeIsRepo && a.repository == b.repository && a.branch == b.branch && a.prStatus == b.prStatus && a.prCI == b.prCI
      && a.collapsedImageTint == b.collapsedImageTint && a.collapsedBadge == b.collapsedBadge
      && a.badge == b.badge && a.pinned == b.pinned && a.parentId == b.parentId && a.lastChild == b.lastChild && a.treeParent == b.treeParent && a.childCount == b.childCount && a.highlight == b.highlight && ea == eb
  }

  private func updatePlaceholder() {
    placeholder.text = placeholderText
    placeholder.isHidden = hasRows || placeholderText.isEmpty
  }

  // MARK: Cells

  private func configure(_ cell: UICollectionViewListCell, _ item: Item) {
    guard let entry = entries[item] else { return }
    let muted = archivedStyle
    let current = entry.kind == .session && entry.row.id == selectedRowId
    let emit: (String) -> Void = { [weak self] action in
      self?.forwarded?("rowAction", ["id": entry.row.id, "actionId": action])
    }
    cell.contentConfiguration = UIHostingConfiguration {
      // UI Verify and VoiceOver tooling address rows by their stable row id.
      switch entry.kind {
      case .header:
        GroupHeader(row: entry.row, expanded: entry.expanded, canToggle: entry.canToggle, onAction: emit)
          .accessibilityIdentifier(entry.row.id)
      case .link:
        GroupHeader(row: entry.row, expanded: nil, canToggle: false, onAction: emit)
          .accessibilityIdentifier(entry.row.id)
      case .session:
        ChatRowContent(
          row: entry.row, details: details, owner: owners[entry.row.id], muted: muted,
          expanded: entry.canToggle ? entry.expanded : nil,
          onOpen: { [weak self] in self?.forwarded?("rowPress", ["id": entry.row.id]) },
          onToggle: { [weak self] in self?.toggleOpener(entry.row.id) }
        )
        .accessibilityAddTraits(current ? .isSelected : [])
        .accessibilityIdentifier(entry.row.id)
      case .more: MoreRowContent(title: entry.row.title).accessibilityIdentifier(entry.row.id)
      }
    }
    .margins(.all, 0)
    .minSize(height: entry.kind == .session && !entry.row.parentId.isEmpty ? LodySize.controlMd : LodySize.listRow)
    cell.accessories = []
    // iOS highlights rows on press; Android uses ripple.
    // The archived page is already as grey as fill.pressed, so it highlights with a translucent fill.
    let pressed = archivedStyle ? LodyUIColor.fillSelected : LodyUIColor.fillPressed
    cell.accessibilityIdentifier = entry.row.id
    cell.accessibilityTraits = current ? [.button, .selected] : .button
    cell.configurationUpdateHandler = { cell, state in
      var background = UIBackgroundConfiguration.clear()
      background.backgroundColor = state.isHighlighted || state.isSelected ? pressed : current ? LodyUIColor.fillSelected : .clear
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
  let onOpen: () -> Void
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
    // Reserve separate space for navigation and disclosure; the family target must not
    // consume the opener's bottom padding.
    VStack(alignment: .leading, spacing: 0) {
      if let expanded {
        // Adjacent SwiftUI buttons arbitrate touch tolerance together. Leaving the
        // opener to UIKit cell selection lets disclosure steal taps above its bounds.
        Button(action: onOpen) {
          content.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        familyToggle(expanded)
      } else {
        content
      }
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
    .accessibilityAction { onOpen() }
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
      .padding(.vertical, LodySpacing.xs)
      .frame(maxWidth: .infinity, minHeight: LodySize.listRow, alignment: .topLeading)
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

/// Home group labels the person collapsed, stored per device by section id. Headers observe it,
/// so a toggle turns the chevron of the label already on screen.
@MainActor @Observable
private final class ChatGroupFolds {
  private static let key = "homeCollapsedGroups"
  private var collapsed = Set(UserDefaults.standard.stringArray(forKey: ChatGroupFolds.key) ?? [])
  /// Home labels collapse; search labels do not.
  var enabled = true
  /// Archived buckets reuse the activity ids, so they fold separately.
  var scope = ""

  func isCollapsed(_ id: String) -> Bool { enabled && collapsed.contains(scope + id) }

  func toggle(_ id: String) {
    let key = scope + id
    if collapsed.remove(key) == nil { collapsed.insert(key) }
    UserDefaults.standard.set(Array(collapsed).sorted(), forKey: Self.key)
  }
}

private struct SectionTitle: View {
  let text: String
  var repository = ""
  let folds: ChatGroupFolds
  let groupId: String
  let onToggle: () -> Void

  var body: some View {
    if text.isEmpty {
      Color.clear.frame(height: LodySpacing.sm)
    } else if folds.enabled {
      let collapsed = folds.isCollapsed(groupId)
      Button(action: onToggle) {
        label(chevron: collapsed)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      .accessibilityValue(String(localized: String.LocalizationValue(collapsed ? "native.list.collapsed" : "native.list.expanded"), bundle: .lody))
      .accessibilityIdentifier("label:" + groupId)
    } else {
      label(chevron: nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("label:" + groupId)
    }
  }

  /// `chevron` is the collapsed state when the group can fold: pointing down while open, right when collapsed.
  private func label(chevron collapsed: Bool?) -> some View {
    HStack(spacing: LodySpacing.xs) {
      if !repository.isEmpty {
        // The project's logo in its original colours, unlike the muted row marks.
        RepositoryIcon(repository: repository, muted: false)
      }
      Text(text)
        .lodyTextStyle(.groupLabel)
        .foregroundStyle(LodyColor.textTertiary)
      if let collapsed {
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(LodyColor.textTertiary)
          .rotationEffect(.degrees(collapsed ? 0 : 90))
          .animation(LodySpring.snappy, value: collapsed)
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, LodyLayout.listEdgeX)
    .padding(.top, LodySpacing.xs)
    .padding(.bottom, LodySpacing.xs)
    .frame(maxWidth: .infinity, alignment: .leading)
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
