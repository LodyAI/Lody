import UIKit

/// A turn's background tasks and sub-agents in a near full-screen sheet (web's task panel, split
/// like its tabs): a segmented control between Subagents and Tasks when the turn has both, then
/// an inset-grouped list, one row per task (state glyph or live spinner, actor · description, the
/// latest step while it runs or how it ended). Rows come from the live feed and change through a
/// diffable snapshot, so tasks arriving, settling or switching segment animate natively; a row
/// pushes the task's run inside the sheet.
@MainActor
final class TasksController: UIViewController, UICollectionViewDelegate {
  enum Group: String { case subagents, tasks }

  struct Task: Hashable {
    let itemId: String
    let actor: String
    let description: String
    let state: String
    let latest: String
    let result: String
    let group: Group
    var running: Bool { state == "pending" || state == "in_progress" || state == "running" }
  }

  let entryId: String
  var onOpen: ((String) -> Void)?
  private var tasks: [Task] = []
  private var group = Group.subagents
  private let segments = UISegmentedControl()
  private lazy var collection = UICollectionView(frame: .zero, collectionViewLayout: Self.layout())
  // Identity is the task id: a task that changes state reconfigures in place instead of
  // leaving and re-entering the list.
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private var byId: [String: Task] = [:]

  init(entryId: String) {
    self.entryId = entryId
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private static func layout() -> UICollectionViewLayout {
    var configuration = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
    configuration.backgroundColor = .systemGroupedBackground
    return UICollectionViewCompositionalLayout.list(using: configuration)
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemGroupedBackground
    segments.insertSegment(withTitle: String(localized: "native.chat.tasks.subagents", bundle: .lody), at: 0, animated: false)
    segments.insertSegment(withTitle: String(localized: "native.chat.tasks.others", bundle: .lody), at: 1, animated: false)
    segments.selectedSegmentIndex = 0
    segments.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.group = self.segments.selectedSegmentIndex == 0 ? .subagents : .tasks
      UISelectionFeedbackGenerator().selectionChanged()
      self.apply(animated: true)
    }, for: .valueChanged)
    segments.translatesAutoresizingMaskIntoConstraints = false
    collection.translatesAutoresizingMaskIntoConstraints = false
    collection.delegate = self
    view.addSubview(collection)
    view.addSubview(segments)
    NSLayoutConstraint.activate([
      segments.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
      segments.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
      segments.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
      collection.topAnchor.constraint(equalTo: view.topAnchor),
      collection.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      collection.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      collection.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    let registration = UICollectionView.CellRegistration<UICollectionViewListCell, Task> { cell, _, task in
      var content = UIListContentConfiguration.subtitleCell()
      let title = NSMutableAttributedString(string: task.actor, attributes: [.foregroundColor: UIColor.label])
      if !task.description.isEmpty, task.description != task.actor {
        title.append(NSAttributedString(string: " · " + task.description, attributes: [.foregroundColor: UIColor.secondaryLabel]))
      }
      content.attributedText = title
      content.textProperties.font = .preferredFont(forTextStyle: .subheadline)
      content.textProperties.numberOfLines = 2
      let symbols = ["completed": "checkmark", "failed": "xmark", "cancelled": "slash.circle", "unknown": "questionmark.circle"]
      if !task.running {
        content.image = UIImage(systemName: symbols[task.state] ?? "circle")
        content.imageProperties.tintColor = task.state == "failed" ? .systemRed : .secondaryLabel
        content.imageProperties.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .subheadline, scale: .small)
      }
      let detail = task.running ? task.latest : (task.state == "failed" ? task.result : "")
      if !detail.isEmpty {
        content.secondaryText = detail
        content.secondaryTextProperties.font = .preferredFont(forTextStyle: .footnote)
        content.secondaryTextProperties.color = task.state == "failed" ? .systemRed : .tertiaryLabel
        content.secondaryTextProperties.numberOfLines = 1
      }
      cell.contentConfiguration = content
      var accessories: [UICellAccessory] = [.disclosureIndicator()]
      if task.running {
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        accessories.append(.customView(configuration: .init(customView: spinner, placement: .leading())))
      }
      cell.accessories = accessories
      cell.accessibilityLabel = [task.actor, task.description, detail].filter { !$0.isEmpty }.joined(separator: ", ")
    }
    dataSource = UICollectionViewDiffableDataSource(collectionView: collection) { [weak self] collection, index, id in
      guard let task = self?.byId[id] else { return nil }
      return collection.dequeueConfiguredReusableCell(using: registration, for: index, item: task)
    }
    apply(animated: false)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    // The list scrolls under the segmented control, which floats on the sheet's top edge.
    let top = segments.isHidden ? 0 : segments.frame.maxY + 8 - view.safeAreaInsets.top
    if collection.contentInset.top != top {
      collection.contentInset.top = top
      collection.verticalScrollIndicatorInsets.top = top
    }
  }

  /// The feed's entries JSON; only this entry's tasks are read.
  func update(_ entriesJSON: String) {
    let entries = (try? JSONSerialization.jsonObject(with: Data(entriesJSON.utf8))) as? [[String: Any]] ?? []
    let items = entries.first { $0["id"] as? String == entryId }?["items"] as? [[String: Any]] ?? []
    tasks = items.compactMap(Self.task)
    if isViewLoaded { apply(animated: true) }
  }

  private static func task(_ item: [String: Any]) -> Task? {
    guard item["type"] as? String == "subagent_task", item["skipTranscript"] as? Bool != true,
          let itemId = item["itemId"] as? String else { return nil }
    let run = item["run"] as? [String: Any]
    let steps = run?["items"] as? [[String: Any]] ?? []
    let last = steps.last
    var latest = (last?["title"] as? String) ?? (last?["text"] as? String)?.split(separator: "\n").first.map(String.init) ?? ""
    if latest.isEmpty { latest = item["lastToolName"] as? String ?? "" }
    let state = (run?["state"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (item["status"] as? String ?? "pending")
    let actor = (item["actor"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "native.chat.transcript.subtask", bundle: .lody)
    return Task(
      itemId: itemId, actor: actor, description: item["description"] as? String ?? "",
      state: state, latest: latest.trimmingCharacters(in: .whitespaces),
      result: ((item["error"] as? String) ?? (item["summary"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
      group: Group(rawValue: item["group"] as? String ?? "") ?? .subagents
    )
  }

  private func apply(animated: Bool) {
    let both = tasks.contains { $0.group == .subagents } && tasks.contains { $0.group == .tasks }
    if !both, let only = tasks.first?.group { group = only }
    segments.selectedSegmentIndex = group == .subagents ? 0 : 1
    if segments.isHidden == both {
      UIView.animate(withDuration: animated ? 0.25 : 0) {
        self.segments.isHidden = !both
        self.segments.alpha = both ? 1 : 0
        self.view.setNeedsLayout()
        self.view.layoutIfNeeded()
      }
    }
    let previous = byId
    byId = Dictionary(tasks.map { ($0.itemId, $0) }, uniquingKeysWith: { _, last in last })
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    let ids = tasks.filter { $0.group == group }.map(\.itemId)
    snapshot.appendItems(ids)
    snapshot.reconfigureItems(ids.filter { previous[$0] != nil && previous[$0] != byId[$0] })
    dataSource.apply(snapshot, animatingDifferences: animated && view.window != nil)
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
    onOpen?(id)
  }
}
