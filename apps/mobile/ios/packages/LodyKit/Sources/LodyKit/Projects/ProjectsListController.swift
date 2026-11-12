import LodyDesignSystem
import SwiftUI
import UIKit

/// iPhone Projects tab: every project as a card, newest activity first, under the Chats header
/// (workspace capsule, sync pill, search, view menu) without a title. Search filters the cards in
/// place; the view menu holds the shared My / Team scope, the source (all / GitHub / local) and
/// whether projects without open chats show. Cards open the existing `ProjectController`; their
/// context menu reuses `SessionRows.projectMenu`. Android: `ProjectCardList`.
@MainActor
final class ProjectsListController: UIViewController, UICollectionViewDelegate {
  private let source: SessionSource
  private lazy var actions = SessionActions(source: source)
  private let chrome = InboxChrome()
  private var list: UICollectionView!
  private var data: UICollectionViewDiffableDataSource<Int, String>!
  private var cards: [String: ProjectCard] = [:]
  private let empty = UILabel()
  private var query = ""
  private var observers: [NSObjectProtocol] = []
  private var clock: Timer?

  init(source: SessionSource = .live) {
    self.source = source
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
    var section: NSCollectionLayoutSection {
      let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(76))
      let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [NSCollectionLayoutItem(layoutSize: size)])
      let section = NSCollectionLayoutSection(group: group)
      section.interGroupSpacing = LodySpacing.sm
      section.contentInsets = NSDirectionalEdgeInsets(
        top: LodySpacing.xs, leading: LodyLayout.screenPaddingX, bottom: LodySpacing.lg, trailing: LodyLayout.screenPaddingX)
      return section
    }
    list = UICollectionView(frame: view.bounds, collectionViewLayout: UICollectionViewCompositionalLayout(section: section))
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.backgroundColor = .clear
    list.alwaysBounceVertical = true
    list.keyboardDismissMode = .onDrag
    list.accessibilityIdentifier = "home-projects-list"
    list.delegate = self
    view.addSubview(list)
    let registration = UICollectionView.CellRegistration<UICollectionViewCell, String> { [weak self] cell, _, id in
      guard let card = self?.cards[id] else { return }
      cell.contentConfiguration = UIHostingConfiguration { ProjectCardView(card: card, now: LodyRelativeTime.now()) }
        .margins(.all, 0)
      cell.accessibilityIdentifier = "project-card:" + card.id
    }
    data = UICollectionViewDiffableDataSource(collectionView: list) { collection, indexPath, id in
      collection.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
    }
    empty.font = .dynamic(of: 15)
    empty.textColor = .secondaryLabel
    empty.textAlignment = .center
    empty.numberOfLines = 0
    empty.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(empty)
    NSLayoutConstraint.activate([
      empty.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
      empty.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
      empty.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: LodyLayout.screenPaddingX),
    ])
    wireChrome()
    observers = (source.changes + [UIApplication.didBecomeActiveNotification, .lodyHomeGroupingChanged]).map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.render() }
      }
    }
    // Relative times move on even when nothing else does.
    clock = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.render(reconfigure: true) }
    }
    render()
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
      render()
    } else {
      chrome.detach()
    }
  }

  private func wireChrome() {
    chrome.compactMenu = { ProjectsListController.viewMenu() }
    chrome.selectWorkspace = { id in CatalogSession.shared.selectWorkspace(id) }
    chrome.openSettings = { [weak self] in LodyShell.shared.openPage("settings", options: ["present": true], from: self?.parent) }
    chrome.openDebug = { [weak self] in LodyShell.shared.openPage("debug", from: self?.parent) }
    chrome.searchChanged = { [weak self] text in
      guard let self, text != self.query else { return }
      self.query = text
      self.render()
    }
  }

  private func render(reconfigure: Bool = false) {
    guard isViewLoaded else { return }
    let state = source.state
    guard !state.userId.isEmpty else {
      chrome.update(nil)
      apply([], reconfigure: false)
      empty.text = ""
      return
    }
    chrome.update(InboxChrome.Model(
      accountEmail: state.accountEmail,
      workspaces: state.workspaces, selected: state.workspace,
      devices: InboxDevices(catalog: state.catalog, presence: state.presence),
      running: state.catalog.sessions.filter { !$0.archived && SessionState($0) == .live }.count,
      connection: state.connected ? (state.loading ? .syncing : .live) : .connecting
    ))
    let owner = HomeScope.stored == .mine ? state.userId : nil
    let next = ProjectCards.build(state.catalog, owner: owner, source: .stored, hideEmpty: ProjectSource.hidesEmpty, query: query)
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if next.isEmpty {
      empty.text = term.isEmpty
        ? String(localized: String.LocalizationValue(state.loading ? "sessions.placeholder.loading" : "home.projects.empty"), bundle: .lody)
        : String.localizedStringWithFormat(String(localized: "home.projects.noMatch", bundle: .lody), term)
    }
    empty.isHidden = !next.isEmpty
    apply(next, reconfigure: reconfigure)
  }

  private func apply(_ next: [ProjectCard], reconfigure: Bool) {
    let previous = cards
    cards = Dictionary(next.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(next.map(\.id))
    // Redraw only cards whose content moved (or every card when the clock ticks).
    let changed = next.filter { reconfigure || previous[$0.id] != $0 }.map(\.id).filter { previous[$0] != nil }
    snapshot.reconfigureItems(changed)
    data.apply(snapshot, animatingDifferences: view.window != nil && !UIAccessibility.isReduceMotionEnabled)
  }

  /// The view menu, built on open so its checkmarks match the stored choices.
  private static func viewMenu() -> UIMenu {
    let scope = UIDeferredMenuElement.uncached { completion in
      let current = HomeScope.stored
      completion([(HomeScope.mine, "person", "home.scope.mine"), (.team, "person.2", "home.scope.team")].map { value, symbol, key in
        UIAction(title: String(localized: String.LocalizationValue(key), bundle: .lody), image: UIImage(systemName: symbol),
          state: current == value ? .on : .off) { _ in HomeScope.store(value) }
      })
    }
    let sources = UIDeferredMenuElement.uncached { completion in
      let current = ProjectSource.stored
      completion([(ProjectSource.all, "square.grid.2x2"), (.github, "chevron.left.forwardslash.chevron.right"), (.local, "laptopcomputer")]
        .map { value, symbol in
          UIAction(title: String(localized: String.LocalizationValue("home.projects.source." + value.rawValue), bundle: .lody),
            image: UIImage(systemName: symbol), state: current == value ? .on : .off) { _ in ProjectSource.store(value) }
        })
    }
    // Built when the menu opens, and a tap closes it, so the checkmark always shows the stored
    // choice (a kept-open menu never redrew it).
    let hide = UIDeferredMenuElement.uncached { completion in
      let on = ProjectSource.hidesEmpty
      completion([UIAction(title: String(localized: "home.projects.hideEmpty", bundle: .lody), image: UIImage(systemName: "eye.slash"),
        state: on ? .on : .off) { _ in ProjectSource.storeHidesEmpty(!on) }])
    }
    return UIMenu(children: [
      UIMenu(title: String(localized: "home.view.scope", bundle: .lody), options: [.displayInline, .singleSelection], children: [scope]),
      UIMenu(title: String(localized: "home.projects.source", bundle: .lody), options: [.displayInline, .singleSelection], children: [sources]),
      UIMenu(options: .displayInline, children: [hide]),
    ])
  }

  // MARK: Collection view

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = data.itemIdentifier(for: indexPath) else { return }
    actions.open("project:\(id)", from: self)
  }

  func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint)
    -> UIContextMenuConfiguration? {
    guard let indexPath = indexPaths.first, let id = data.itemIdentifier(for: indexPath),
          let project = source.state.catalog.projects.first(where: { $0.id == id }) else { return nil }
    return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: nil) { [weak self] _ in
      UIMenu(children: SessionRows.projectMenu(project).map { item in
        UIAction(title: item.title, image: UIImage(systemName: item.symbol)) { _ in
          guard let self else { return }
          if item.id == "copyPath" {
            UIPasteboard.general.string = project.rootPath
            return
          }
          self.actions.perform(item.id, row: "project:\(id)", from: self)
        }
      })
    }
  }
}

/// One project card (Android `ProjectCardView`): a 40 pt logo centred on both lines (the GitHub
/// owner's avatar, else the name's initial). Line 1: the name and when it last moved. Line 2: the
/// computer (local) or GitHub, and the most pressing state of its open chats (nothing when none).
struct ProjectCardView: View {
  let card: ProjectCard
  let now: Double

  var body: some View {
    // The logo is centred on both lines; the text column carries the name and the state.
    HStack(spacing: LodySpacing.md) {
      mark
      VStack(alignment: .leading, spacing: LodySpacing.xxs) {
        HStack(spacing: LodySpacing.sm) {
          Text(card.title)
            .lodyTextStyle(.headline)
            .foregroundStyle(LodyColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: .infinity, alignment: .leading)
          if let updated = card.updatedAt {
            Text(LodyRelativeTime.compact(updated, now: now))
              .lodyTextStyle(.footnote)
              .foregroundStyle(LodyColor.textTertiary)
          }
        }
        HStack(spacing: LodySpacing.sm) {
          Text(card.machine ?? (card.github ? "GitHub" : ""))
            .lodyTextStyle(.footnote)
            .foregroundStyle(LodyColor.textSecondary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
          status
        }
      }
    }
    .padding(.horizontal, LodySpacing.lg)
    .padding(.vertical, LodySpacing.md)
    .background(LodyColor.bgSunken, in: RoundedRectangle(cornerRadius: LodyRadius.xl, style: .continuous))
    .contentShape(RoundedRectangle(cornerRadius: LodyRadius.xl, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
  }

  /// GitHub: the repository owner's avatar. Otherwise the project name's first letter.
  @ViewBuilder private var mark: some View {
    if card.github {
      RepositoryIcon(repository: card.title, size: LodySize.avatarLg, opacity: 0.8)
    } else {
      monogram
    }
  }

  private var monogram: some View {
    let name = card.github ? (card.title.split(separator: "/").last.map(String.init) ?? card.title) : card.title
    return Text(name.first.map { String($0).uppercased() } ?? "")
      .lodyTextStyle(.headline)
      .foregroundStyle(LodyColor.textSecondary)
      .frame(width: LodySize.avatarLg, height: LodySize.avatarLg)
      .background(LodyColor.fillSecondary, in: Circle())
      .accessibilityHidden(true)
  }

  @ViewBuilder private var status: some View {
    let (summary, count) = card.summary
    HStack(spacing: LodySpacing.xs) {
      switch summary {
      case .running: LodyWorkingGrid(size: 12, color: LodyColor.accentDefault)
      case .attention:
        Image(systemName: "hand.raised.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(LodyColor.warningDefault)
      case .finished: Circle().fill(LodyColor.accentDefault).frame(width: 7, height: 7)
      case .pullRequests:
        Image(systemName: "arrow.triangle.pull").font(.system(size: 11, weight: .medium)).foregroundStyle(LodyColor.iconSecondary)
      case .open, .empty: EmptyView()
      }
      Text(Self.text(summary, count))
        .lodyTextStyle(.subhead)
        .foregroundStyle(Self.color(summary))
        .lineLimit(1)
    }
  }

  private static func text(_ summary: ProjectCard.Summary, _ count: Int) -> String {
    let keys: [ProjectCard.Summary: String] = [
      .attention: "home.projects.attention", .running: "home.projects.running", .finished: "home.projects.finished",
      .pullRequests: "home.projects.pullRequests", .open: "home.projects.open",
    ]
    guard let key = keys[summary] else { return "" }
    return String.localizedStringWithFormat(String(localized: String.LocalizationValue(key), bundle: .lody), count)
  }

  private static func color(_ summary: ProjectCard.Summary) -> Color {
    switch summary {
    case .attention: LodyColor.warningDefault
    case .running, .finished: LodyColor.accentFg
    case .pullRequests, .open: LodyColor.textSecondary
    case .empty: LodyColor.textTertiary
    }
  }
}
