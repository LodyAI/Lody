import LodyCore
import LodyDesignSystem
import SwiftUI
import UIKit

/// iPhone Schedules tab: the Chats header without a title (workspace capsule, search filtering by
/// name), an overview of four state-group count tiles (Active, Needs attention, Paused, Ended; a
/// tile filters both sections to its group), then inset-grouped Scheduled tasks and Scheduled
/// messages (hidden when empty) with counts. Rows, needing a look first: an Agent tile badged with
/// the state glyph; name (dimmed once ended) with the state in words (tinted only for attention);
/// frequency; Agent · computer · project; the reason when it needs a look. Trailing swipe and the
/// context menu run, pause / resume, open the last chat and delete (always confirmed); the row
/// opens `ScheduleEditorController`. Reloads on appear, pull to refresh, after every command and on
/// workspace change.
@MainActor
final class SchedulesController: UIViewController, UICollectionViewDelegate {
  private enum Section: String { case overview, tasks, messages }
  private static let overviewId = "overview:groups"

  private let source: SessionSource
  private let service: ScheduleService
  private let chrome = InboxChrome(searchPlaceholder: String(localized: "schedules.search", bundle: .lody))
  private var list: UICollectionView!
  private var data: UICollectionViewDiffableDataSource<Section, String>!
  private let refresh = UIRefreshControl()
  private var result: RuntimeContract.SchedulesResult?
  private var items: [String: ScheduleItem] = [:]
  private var loading = false
  private var failure: String?
  private var query = ""
  private var filter: RuntimeContract.ScheduleStateGroup?
  private var counts: [RuntimeContract.ScheduleStateGroup: Int] = [:]
  private var scope = ""
  private var version = 0
  private var busy = Set<String>()
  private var observers: [NSObjectProtocol] = []
  private var clock: Timer?

  init(source: SessionSource = .live, service: ScheduleService = .live) {
    self.source = source
    self.service = service
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    clock?.invalidate()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = LodyUIColor.bgBase
    let layout = UICollectionViewCompositionalLayout { [weak self] index, environment in
      let section = self?.data?.sectionIdentifier(for: index)
      var configuration = UICollectionLayoutListConfiguration(appearance: section == .overview ? .plain : .insetGrouped)
      configuration.backgroundColor = .clear
      if section == .overview {
        configuration.showsSeparators = false
        configuration.headerMode = .none
      } else {
        configuration.headerMode = .supplementary
        configuration.headerTopPadding = LodySpacing.xs
        configuration.separatorConfiguration.bottomSeparatorInsets.leading = 68
        configuration.trailingSwipeActionsConfigurationProvider = { [weak self] indexPath in
          self?.swipeActions(at: indexPath)
        }
      }
      return NSCollectionLayoutSection.list(using: configuration, layoutEnvironment: environment)
    }
    list = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.backgroundColor = .clear
    list.alwaysBounceVertical = true
    list.keyboardDismissMode = .onDrag
    list.accessibilityIdentifier = "home-schedules-list"
    list.delegate = self
    refresh.addAction(UIAction { [weak self] _ in self?.reload() }, for: .valueChanged)
    list.refreshControl = refresh
    view.addSubview(list)
    let cell = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
      guard let self, let item = self.items[id] else { return }
      self.configure(cell, item)
    }
    let overview = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, _ in
      guard let self else { return }
      cell.contentConfiguration = UIHostingConfiguration {
        ScheduleOverviewView(counts: self.counts, selected: self.filter) { [weak self] group in self?.pick(group) }
      }
      .margins(.horizontal, LodyLayout.screenPaddingX)
      .margins(.vertical, LodySpacing.sm)
      var background = UIBackgroundConfiguration.clear()
      background.backgroundColor = .clear
      cell.backgroundConfiguration = background
      cell.accessibilityIdentifier = "schedules-overview"
    }
    let header = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(elementKind: UICollectionView.elementKindSectionHeader) {
      [weak self] header, _, indexPath in
      guard let self, let section = self.data.sectionIdentifier(for: indexPath.section) else { return }
      var content = UIListContentConfiguration.header()
      content.text = ScheduleFormat.text(section == .messages ? "section.messages" : "section.tasks")
      content.secondaryText = String(self.data.snapshot().numberOfItems(inSection: section))
      content.prefersSideBySideTextAndSecondaryText = true
      header.contentConfiguration = content
      header.accessibilityIdentifier = "schedules-section:" + section.rawValue
    }
    data = UICollectionViewDiffableDataSource(collectionView: list) { collection, indexPath, id in
      id == Self.overviewId
        ? collection.dequeueConfiguredReusableCell(using: overview, for: indexPath, item: id)
        : collection.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: id)
    }
    data.supplementaryViewProvider = { collection, _, indexPath in
      collection.dequeueConfiguredReusableSupplementary(using: header, for: indexPath)
    }
    wireChrome()
    observers = source.changes.map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.sourceChanged() }
      }
    }
    // Relative times ("Runs 9:00 AM", "Tomorrow …") move on even when nothing else does.
    clock = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.render(reconfigure: true) }
    }
    scope = source.state.key
    renderChrome()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    reload()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    LodyScrollEdges.bind(list, to: self)
    chrome.layout()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    if let parent {
      chrome.attach(to: parent, content: self, scrollView: list)
      renderChrome()
    } else {
      chrome.detach()
    }
  }

  // MARK: Loading

  private func sourceChanged() {
    renderChrome()
    let next = source.state.key
    guard next != scope else { return }
    scope = next
    result = nil
    items = [:]
    reload()
  }

  private func reload() {
    guard isViewLoaded else { return }
    let state = source.state
    version += 1
    let id = version
    guard !state.workspaceId.isEmpty else {
      result = nil
      loading = false
      refresh.endRefreshing()
      render()
      return
    }
    loading = true
    let pulled = refresh.isRefreshing
    render()
    Task { [weak self, service, workspaceId = state.workspaceId] in
      var value: RuntimeContract.SchedulesResult?
      var failure: String?
      do { value = try await service.list(workspaceId) }
      catch { failure = ScheduleFailure.message(error, write: false) }
      guard let self, self.version == id else { return }
      // A failed refresh keeps the last list; the error shows only when there is nothing to show.
      if let value { self.result = value }
      if pulled, self.result != nil, let failure { LodyToastOverlay.shared.show(message: failure, kind: .error) }
      self.failure = failure
      self.loading = false
      self.refresh.endRefreshing()
      self.render()
    }
  }

  // MARK: Rendering

  private func wireChrome() {
    chrome.showsViewMenu = false
    chrome.selectWorkspace = { id in
      guard NativeHomeFixture.active else {
        CatalogSession.shared.selectWorkspace(id)
        return
      }
      Task { try? await NativeHomeFixture.request("selectWorkspace", ["workspaceId": id]) }
    }
    chrome.openSettings = { [weak self] in LodyShell.shared.openPage("settings", options: ["present": true], from: self?.parent) }
    chrome.openDebug = { [weak self] in LodyShell.shared.openPage("debug", from: self?.parent) }
    chrome.newSession = { [weak self] in self?.newSchedule() }
    chrome.searchChanged = { [weak self] text in
      guard let self, text != self.query else { return }
      self.query = text
      self.render()
    }
  }

  private func renderChrome() {
    guard isViewLoaded else { return }
    let state = source.state
    guard !state.userId.isEmpty else {
      chrome.update(nil)
      return
    }
    chrome.update(InboxChrome.Model(
      accountEmail: state.accountEmail,
      workspaces: state.workspaces, selected: state.workspace,
      devices: InboxDevices(catalog: state.catalog, presence: state.presence),
      running: state.catalog.sessions.filter { !$0.archived && SessionState($0) == .live }.count,
      mode: 0, sort: .activity, connection: Self.connection(state)
    ))
  }

  private static func connection(_ state: SessionListState) -> HomeSyncState {
    if !state.connected { return .offline }
    return state.loading ? .syncing : .live
  }

  private func render(reconfigure: Bool = false) {
    guard isViewLoaded else { return }
    let all = result?.items ?? []
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let searched = term.isEmpty ? all : all.filter { $0.title.localizedCaseInsensitiveContains(term) }
    counts = Dictionary(grouping: searched, by: \.state.group).mapValues(\.count)
    // A filter whose group emptied (after a command or a search) falls away.
    if let filter, (counts[filter] ?? 0) == 0 { self.filter = nil }
    let rank = Dictionary(uniqueKeysWithValues: ScheduleTone.order.enumerated().map { ($1, $0) })
    // Needing a look first, then active, paused and ended; the runtime's order within each group.
    let shown = searched.enumerated()
      .filter { filter == nil || $0.element.state.group == filter }
      .sorted { (rank[$0.element.state.group] ?? 0, $0.offset) < (rank[$1.element.state.group] ?? 0, $1.offset) }
      .map(\.element)
    let previous = items
    items = Dictionary(all.map { ($0.scheduleId, $0) }, uniquingKeysWith: { first, _ in first })
    var snapshot = NSDiffableDataSourceSnapshot<Section, String>()
    if !searched.isEmpty {
      snapshot.appendSections([.overview])
      snapshot.appendItems([Self.overviewId], toSection: .overview)
    }
    let tasks = shown.filter { !$0.scheduledMessage }.map(\.scheduleId)
    let messages = shown.filter(\.scheduledMessage).map(\.scheduleId)
    if !tasks.isEmpty {
      snapshot.appendSections([.tasks])
      snapshot.appendItems(tasks, toSection: .tasks)
    }
    if !messages.isEmpty {
      snapshot.appendSections([.messages])
      snapshot.appendItems(messages, toSection: .messages)
    }
    let changed = snapshot.itemIdentifiers.filter { id in
      guard let before = previous[id] else { return false }
      return reconfigure || before != items[id]
    }
    snapshot.reconfigureItems(changed)
    if data.snapshot().indexOfItem(Self.overviewId) != nil, snapshot.indexOfItem(Self.overviewId) != nil {
      snapshot.reconfigureItems([Self.overviewId])
    }
    // Counts live in the headers; rebuild them with the sections.
    snapshot.reloadSections(snapshot.sectionIdentifiers.filter { $0 != .overview })
    data.apply(snapshot, animatingDifferences: view.window != nil && !UIAccessibility.isReduceMotionEnabled)
    setNeedsUpdateContentUnavailableConfiguration()
  }

  override func updateContentUnavailableConfiguration(using state: UIContentUnavailableConfigurationState) {
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let empty = (data?.snapshot().itemIdentifiers.filter { $0 != Self.overviewId }.count ?? 0) == 0
    var configuration: UIContentUnavailableConfiguration?
    if !source.state.workspaceId.isEmpty, empty {
      if result == nil, loading {
        configuration = .loading()
        configuration?.text = ScheduleFormat.text("loading")
      } else if result == nil, let failure {
        var error = UIContentUnavailableConfiguration.empty()
        error.image = UIImage(systemName: "exclamationmark.triangle")
        error.text = failure
        var retry = UIButton.Configuration.bordered()
        retry.title = ScheduleFormat.text("retry")
        error.button = retry
        error.buttonProperties.primaryAction = UIAction { [weak self] _ in self?.reload() }
        configuration = error
      } else if !term.isEmpty || filter != nil {
        var none = UIContentUnavailableConfiguration.search()
        none.text = ScheduleFormat.text("noMatches")
        configuration = none
      } else if result != nil {
        var none = UIContentUnavailableConfiguration.empty()
        none.image = LodyIcon.clock.uiImage
        none.text = ScheduleFormat.text("empty")
        none.secondaryText = ScheduleFormat.text("emptyHelp")
        var create = UIButton.Configuration.filled()
        create.title = ScheduleFormat.text("new")
        create.baseBackgroundColor = .lodyInk
        create.baseForegroundColor = .lodyGround
        create.cornerStyle = .capsule
        none.button = create
        none.buttonProperties.primaryAction = UIAction { [weak self] _ in self?.newSchedule() }
        configuration = none
      }
    }
    contentUnavailableConfiguration = configuration
  }

  private func configure(_ cell: UICollectionViewListCell, _ item: ScheduleItem) {
    let zone = ScheduleFormat.zone(item, result: result)
    let status = ScheduleFormat.state(item.state, zone: zone)
    cell.contentConfiguration = UIHostingConfiguration { ScheduleRowView(item: item, zone: zone) }
      .margins(.horizontal, LodyLayout.listRowPaddingX)
      .margins(.vertical, LodySpacing.md)
    cell.accessories = []
    var background = UIBackgroundConfiguration.listCell()
    background.backgroundColor = .lodyOpaqueCard
    cell.backgroundConfiguration = background
    cell.isAccessibilityElement = true
    cell.accessibilityTraits = .button
    cell.accessibilityLabel = item.title
    cell.accessibilityValue = [ScheduleFormat.detail(item, zone: zone), status.label, status.detail ?? ""]
      .filter { !$0.isEmpty }.joined(separator: ", ")
    cell.accessibilityIdentifier = "schedule:" + item.scheduleId
  }

  private func pick(_ group: RuntimeContract.ScheduleStateGroup) {
    filter = filter == group ? nil : group
    UISelectionFeedbackGenerator().selectionChanged()
    render()
  }

  // MARK: Actions

  /// The tab bar's "+": a new schedule's editor, pushed over the list.
  func newSchedule() {
    let state = source.state
    guard state.workspace != nil, !state.workspaceId.isEmpty else {
      LodyToastOverlay.shared.show(message: String(localized: "tabs.toast.signInFirst", bundle: .lody), kind: .neutral)
      return
    }
    open(nil)
  }

  private func open(_ item: ScheduleItem?) {
    let editor = ScheduleEditorController(
      workspaceId: source.state.workspaceId, item: item, zones: result, catalog: source.state.catalog, service: service
    )
    editor.changed = { [weak self] in self?.reload() }
    editor.openChat = { [weak self] item in self?.openChat(item) }
    LodyShell.shared.pushNative(editor, title: item?.title ?? ScheduleFormat.text("new"), from: self)
  }

  /// Owner-only commands; resume and run also need a computer whose CLI runs schedules.
  private func actions(_ item: ScheduleItem) -> [ScheduleAction] {
    guard item.isOwner, !busy.contains(item.scheduleId) else { return [] }
    var result: [ScheduleAction] = []
    if !item.scheduledMessage, item.machineSupported { result.append(.run) }
    if !item.scheduledMessage, item.rule.kind != .manual {
      if item.enabled { result.append(.pause) } else if item.machineSupported { result.append(.resume) }
    }
    result.append(.delete)
    return result
  }

  private func swipeActions(at indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard let id = data.itemIdentifier(for: indexPath), let item = items[id] else { return nil }
    let available = actions(item)
    // Manual tasks offer Run; timed ones Pause / Resume (web's hover action), then Delete.
    let primary = item.rule.kind == .manual ? available.filter { $0 == .run } : available.filter { $0 == .pause || $0 == .resume }
    let shown = (available.contains(.delete) ? [ScheduleAction.delete] : []) + primary
    guard !shown.isEmpty else { return nil }
    let configuration = UISwipeActionsConfiguration(actions: shown.map { action in
      let contextual = UIContextualAction(style: action == .delete ? .destructive : .normal, title: Self.title(action)) {
        [weak self] _, _, done in
        self?.request(action, item)
        done(action != .delete)
      }
      contextual.image = UIImage(systemName: Self.symbol(action))
      if action != .delete { contextual.backgroundColor = .systemGray }
      return contextual
    })
    configuration.performsFirstActionWithFullSwipe = false
    return configuration
  }

  private static func title(_ action: ScheduleAction) -> String {
    let keys: [ScheduleAction: String] = [.run: "runNow", .pause: "pause", .resume: "resume", .delete: "delete"]
    return ScheduleFormat.text(keys[action] ?? "open")
  }

  private static func symbol(_ action: ScheduleAction) -> String {
    let symbols: [ScheduleAction: String] = [.run: "play", .pause: "pause", .resume: "arrow.counterclockwise", .delete: "trash"]
    return symbols[action] ?? "circle"
  }

  /// Delete always confirms; everything else runs at once.
  private func request(_ action: ScheduleAction, _ item: ScheduleItem) {
    guard action == .delete else { return perform(action, item) }
    let alert = UIAlertController(
      title: String(format: ScheduleFormat.text("deleteTitle"), item.title),
      message: ScheduleFormat.text(item.scheduledMessage ? "deleteMessageHelp" : "deleteHelp"), preferredStyle: .alert
    )
    alert.addAction(UIAlertAction(title: ScheduleFormat.text("cancel"), style: .cancel))
    alert.addAction(UIAlertAction(title: ScheduleFormat.text("delete"), style: .destructive) { [weak self] _ in
      self?.perform(.delete, item)
    })
    present(alert, animated: true)
  }

  private func perform(_ action: ScheduleAction, _ item: ScheduleItem) {
    let workspaceId = source.state.workspaceId
    guard !workspaceId.isEmpty, busy.insert(item.scheduleId).inserted else { return }
    let params = RuntimeContract.ScheduleCommandParams(
      workspaceId: workspaceId, action: action, scheduleId: item.scheduleId, requestId: ScheduleService.requestId()
    )
    Task { [weak self, service] in
      do {
        _ = try await service.command(params)
        if action == .run {
          LodyToastOverlay.shared.show(message: String(format: ScheduleFormat.text("runStarted"), item.title), kind: .neutral)
        }
      } catch {
        LodyToastOverlay.shared.show(message: ScheduleFailure.message(error, write: true), kind: .error)
      }
      guard let self else { return }
      self.busy.remove(item.scheduleId)
      self.reload()
    }
  }

  private func openChat(_ item: ScheduleItem) {
    guard let sessionId = item.lastSessionId, source.state.catalog.session(sessionId) != nil else {
      LodyToastOverlay.shared.show(message: String(localized: "session.toast.openFailed", bundle: .lody), kind: .error)
      return
    }
    SessionActions(source: source).open(sessionId, from: self)
  }

  // MARK: Collection view

  func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool {
    data.itemIdentifier(for: indexPath) != Self.overviewId
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = data.itemIdentifier(for: indexPath), let item = items[id] else { return }
    open(item)
  }

  func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint)
    -> UIContextMenuConfiguration? {
    guard let indexPath = indexPaths.first, let id = data.itemIdentifier(for: indexPath), let item = items[id] else { return nil }
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: nil) { [weak self] _ in
      guard let self else { return nil }
      let available = self.actions(item)
      var commands: [UIMenuElement] = available.filter { $0 != .delete }.map { action in
        UIAction(title: Self.title(action), image: UIImage(systemName: Self.symbol(action))) { [weak self] _ in self?.request(action, item) }
      }
      if item.lastSessionId != nil {
        commands.append(UIAction(title: ScheduleFormat.text("openLastChat"), image: UIImage(systemName: "bubble.left")) { [weak self] _ in
          self?.openChat(item)
        })
      }
      var children: [UIMenuElement] = [UIMenu(options: .displayInline, children: commands)]
      if available.contains(.delete) {
        children.append(UIMenu(options: .displayInline, children: [
          UIAction(title: Self.title(.delete), image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
            self?.request(.delete, item)
          },
        ]))
      }
      return UIMenu(children: children)
    }
  }
}
