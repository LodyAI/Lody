import ChatKit
import LodyCore
import UIKit

struct ChatMentionItem: Decodable, Equatable {
  let path: String
  let name: String
  let kind: String
  let subtitle: String
  var insertText: String?
  /// A Role's emoji: it leads the row instead of a symbol (as the run-config Role row).
  var emoji: String?

  /// Folders browse with the files; prompt shortcuts (the runtime lists them with the agent's
  /// commands, inserting `/shortcut:<slug>`) are their own category, as web's mention menu.
  var category: String {
    if kind == "directory" { return "file" }
    if kind == "cmd", (insertText ?? "").hasPrefix("/shortcut:") { return "shortcut" }
    return kind
  }
  /// Whether a trigger's scope includes this item: `/` offers shortcuts and commands (web).
  func inScope(_ scoped: String?) -> Bool {
    guard let scoped else { return true }
    return category == scoped || (scoped == "cmd" && category == "shortcut")
  }
  static let categories = ["file", "skill", "session", "role", "issue", "pr", "shortcut", "cmd"]
  static let labels = ["file": "files", "skill": "skills", "session": "sessions", "role": "roles", "issue": "issues", "pr": "prs", "shortcut": "shortcuts", "cmd": "commands"]
  static let glyphs = ["file": "doc.text", "directory": "folder", "skill": "sparkles", "session": "bubble.left.and.bubble.right", "role": "person.crop.rectangle", "issue": "exclamationmark.circle", "pr": "arrow.triangle.branch", "shortcut": "bolt", "cmd": "command"]

  /// An emoji as a list image (drawn in its own colours, never tinted).
  static func emojiImage(_ emoji: String, size: CGFloat) -> UIImage {
    let font = UIFont.systemFont(ofSize: size * 0.85)
    let image = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
      let text = emoji as NSString
      let bounds = text.size(withAttributes: [.font: font])
      text.draw(at: CGPoint(x: (size - bounds.width) / 2, y: (size - bounds.height) / 2), withAttributes: [.font: font])
    }
    return image.withRenderingMode(.alwaysOriginal)
  }

  func matches(_ query: String) -> Bool {
    query.isEmpty || (name + " " + path + " " + subtitle).localizedStandardContains(query)
  }

  var content: UIListContentConfiguration {
    var content = UIListContentConfiguration.subtitleCell()
    content.text = name
    content.secondaryText = subtitle
    content.textProperties.font = .dynamic(of: 16, weight: .medium)
    content.secondaryTextProperties.font = .dynamic(of: 13)
    content.secondaryTextProperties.color = .secondaryLabel
    content.secondaryTextProperties.numberOfLines = 1
    let glyph = Self.glyphs[kind == "category" ? path : (category == "shortcut" ? "shortcut" : kind)] ?? "doc.text"
    content.image = UIImage(systemName: glyph, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular))
    if kind == "role" {
      content.image = Self.emojiImage(emoji?.isEmpty == false ? emoji! : "🪼", size: 20)
    }
    content.imageProperties.tintColor = .secondaryLabel
    content.imageProperties.maximumSize = CGSize(width: 20, height: 20)
    content.imageProperties.reservedLayoutSize = CGSize(width: 32, height: 32)
    content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 9, leading: 14, bottom: 9, trailing: 14)
    return content
  }
}

/// One level of the mention panel: the categories (or typed matches), one category, or a folder.
enum ChatMentionLevel: Hashable {
  case root
  case category(String)
  case directory(String)
}

/// Notion-style mention panel, docked between the prompt and the keyboard: the prompt stays
/// above it and keeps focus (typing after the trigger filters the visible level), and choosing a
/// category or folder pushes the next level on a native navigation stack.
final class ChatMentionPanel: UIView {
  /// The panel's height while shown; the keyboard sits right below it.
  static let dockHeight: CGFloat = 280
  private let navigation = UINavigationController()
  private let root: ChatMentionLevelController
  private var catalog: [ChatMentionItem] = []
  private(set) var query = ""
  private(set) var scoped: String?
  private var applyingEdit = false
  private var range: NSRange?
  private var dismissedText: String?
  private var browserDraft: (text: String, range: NSRange)?
  private weak var input: UITextView?
  private(set) var showing = false
  var onChange: (() -> Void)?
  /// Kept for hosts that still route a category to a page; the docked panel never asks.
  var onBrowse: (([String: String]) -> Void)?
  /// Reads a prompt shortcut's body by id, so choosing one writes the body (web); without it, or
  /// when the read fails, the `/shortcut:<slug>` token goes in and the runtime expands it at send.
  var loadShortcut: ((String) async throws -> RuntimeContract.PromptShortcut)?
  private var shortcutLoad: Task<Void, Never>?
  private(set) var panelHeight: CGFloat = 0

  override init(frame: CGRect) {
    root = ChatMentionLevelController(level: .root)
    super.init(frame: frame)
    accessibilityIdentifier = "mention-panel"
    isHidden = true
    alpha = 0
    backgroundColor = .systemBackground
    layer.cornerRadius = 20
    layer.cornerCurve = .continuous
    layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    clipsToBounds = true
    root.panel = self
    navigation.setViewControllers([root], animated: false)
    navigation.view.backgroundColor = .clear
    // Levels draw their own compact header; the system bar never shows.
    navigation.setNavigationBarHidden(true, animated: false)
    // A hidden bar would otherwise disable the edge swipe back between levels.
    navigation.interactivePopGestureRecognizer?.delegate = nil
    let separator = UIView()
    separator.backgroundColor = .separator
    separator.isUserInteractionEnabled = false
    for view in [navigation.view!, separator] {
      addSubview(view)
      view.translatesAutoresizingMaskIntoConstraints = false
    }
    NSLayoutConstraint.activate([
      navigation.view.topAnchor.constraint(equalTo: topAnchor),
      navigation.view.bottomAnchor.constraint(equalTo: bottomAnchor),
      navigation.view.leadingAnchor.constraint(equalTo: leadingAnchor),
      navigation.view.trailingAnchor.constraint(equalTo: trailingAnchor),
      separator.topAnchor.constraint(equalTo: topAnchor),
      separator.leadingAnchor.constraint(equalTo: leadingAnchor),
      separator.trailingAnchor.constraint(equalTo: trailingAnchor),
      separator.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      navigation.willMove(toParent: nil)
      navigation.removeFromParent()
      reset(animated: false)
      return
    }
    // Proper containment so the stack gets appearance callbacks and its push transitions.
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController {
        if navigation.parent !== controller {
          navigation.willMove(toParent: nil)
          navigation.removeFromParent()
          controller.addChild(navigation)
          navigation.didMove(toParent: controller)
        }
        break
      }
      responder = current.next
    }
  }

  // NSString ranges match UITextView selections, including emoji before the trigger.
  static func activeRange(text: String, selection: NSRange) -> NSRange? {
    let text = text as NSString
    guard selection.length == 0, selection.location > 0, selection.location <= text.length else { return nil }
    let prefix = text.substring(to: selection.location)
    guard let token = prefix.range(of: "(?:^|\\s)[@$][^\\s@$]*$|^/[^\\s/]*$", options: .regularExpression),
          let at = prefix[token].firstIndex(where: { "@$/".contains($0) }) else { return nil }
    return NSRange(at..<prefix.endIndex, in: prefix)
  }

  func update(input: UITextView, items: [ChatMentionItem], enabled: Bool = true) {
    guard !applyingEdit else { return }
    self.input = input
    catalog = items
    range = Self.activeRange(text: input.text ?? "", selection: input.selectedRange)
    let correction: UITextAutocorrectionType = range != nil && enabled ? .no : .default
    if input.autocorrectionType != correction {
      input.autocorrectionType = correction
      input.reloadInputViews()
    }
    guard input.isFirstResponder, input.markedTextRange == nil, browserDraft == nil,
          enabled, let range, dismissedText != input.text else {
      reset(animated: true)
      return
    }
    query = ((input.text ?? "") as NSString).substring(with: NSRange(location: range.location + 1, length: range.length - 1))
    let trigger = ((input.text ?? "") as NSString).substring(with: NSRange(location: range.location, length: 1))
    scoped = nil
    if trigger == "$" { scoped = "skill" }
    if trigger == "/" { scoped = "cmd" }
    if trigger == "@", let colon = query.firstIndex(of: ":") {
      let namespace = String(query[..<colon])
      if ChatMentionItem.categories.contains(namespace) {
        scoped = namespace
        query = String(query[query.index(after: colon)...])
      }
    }
    // At the root nothing to offer closes the panel; a pushed level shows its own empty state.
    if navigation.viewControllers.count <= 1 && rows(for: .root).isEmpty {
      reset(animated: true)
      return
    }
    for controller in navigation.viewControllers {
      (controller as? ChatMentionLevelController)?.reload(animated: controller === navigation.topViewController && showing)
    }
    setShowing(true)
  }

  /// The rows one level shows for the current query.
  func rows(for level: ChatMentionLevel) -> [ChatMentionItem] {
    let items = catalog.filter { $0.kind != "category" }
    switch level {
    case .root:
      guard query.isEmpty && scoped == nil else {
        let matches = items.filter { $0.inScope(scoped) && $0.matches(query) }
        // `/` leads with prompt shortcuts, then the agent's commands (web's category order).
        guard scoped == "cmd" else { return matches }
        return matches.filter { $0.category == "shortcut" } + matches.filter { $0.category != "shortcut" }
      }
      let provided = catalog.filter { $0.kind == "category" }
      if !provided.isEmpty { return provided }
      return ChatMentionItem.categories.filter { category in
        category == "file" || category == "skill" || items.contains { $0.category == category }
      }.map { category in
        ChatMentionItem(path: category, name: Self.title(category), kind: "category", subtitle: "")
      }
    case .category(let category):
      let scopedItems = items.filter { $0.category == category }
      if category == "file" && query.isEmpty { return scopedItems.filter { Self.parent($0.path).isEmpty } }
      return scopedItems.filter { $0.matches(query) }
    case .directory(let path):
      let files = items.filter { $0.category == "file" }
      if query.isEmpty { return files.filter { Self.parent($0.path) == path } }
      return files.filter { $0.path.hasPrefix(path + "/") && $0.matches(query) }
    }
  }

  static func title(_ category: String) -> String {
    String(localized: String.LocalizationValue("native.chat.mention." + (ChatMentionItem.labels[category] ?? category)), bundle: .lody)
  }

  private static func parent(_ path: String) -> String { (path as NSString).deletingLastPathComponent }

  /// A row was chosen: categories and folders open their level; anything else is inserted.
  func choose(_ item: ChatMentionItem) {
    if item.kind == "category" {
      push(.category(item.path), title: item.name)
    } else if item.kind == "directory" {
      push(.directory(item.path), title: (item.path as NSString).lastPathComponent)
    } else if item.category == "shortcut", loadShortcut != nil {
      insertShortcut(item)
    } else {
      insert(item)
    }
  }

  /// A Role's chip: its emoji and name, as the catalog lists it (web).
  private func roleLabel(_ id: String) -> ChatRoleLabel? {
    guard let role = catalog.first(where: { $0.kind == "role" && ($0.path == id || $0.path.hasPrefix(id + "@")) }) else { return nil }
    return ChatRoleLabel(emoji: role.emoji.flatMap { $0.isEmpty ? nil : $0 } ?? "🪼", name: role.name)
  }

  /// Writes the shortcut's body over the trigger once it is read, if the prompt has not moved on.
  private func insertShortcut(_ item: ChatMentionItem) {
    guard let input, let range, let load = loadShortcut else { return insert(item) }
    let before = input.text ?? ""
    UISelectionFeedbackGenerator().selectionChanged()
    shortcutLoad?.cancel()
    shortcutLoad = Task { @MainActor [weak self] in
      let body = try? await load(item.path)
      guard let self, !Task.isCancelled, input.text == before else { return }
      guard let body, let composer = input as? ChatComposerInput else { return self.insert(item, into: input, range: range) }
      let segments = ChatShortcutInsertion.segments(prompt: body.prompt, mentions: body.mentions) { self.roleLabel($0) }
      let length = segments.reduce(0) { $0 + ($1.text as NSString).length }
      guard NSMaxRange(range) <= (before as NSString).length, (before as NSString).length - range.length + length <= 32000 else { return }
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      self.applyingEdit = true
      composer.insertSegments(segments, replacing: range)
      self.applyingEdit = false
      self.onChange?()
    }
  }

  /// A folder level's own row: reference the folder itself.
  func chooseDirectory(_ path: String) {
    let item = catalog.first { $0.path == path && $0.kind == "directory" }
      ?? ChatMentionItem(path: path, name: (path as NSString).lastPathComponent, kind: "directory", subtitle: "")
    insert(item)
  }

  private func push(_ level: ChatMentionLevel, title: String) {
    let controller = ChatMentionLevelController(level: level)
    controller.panel = self
    controller.title = title
    UISelectionFeedbackGenerator().selectionChanged()
    navigation.pushViewController(controller, animated: !UIAccessibility.isReduceMotionEnabled)
  }

  private func insert(_ item: ChatMentionItem) {
    guard let input, let range else { return }
    insert(item, into: input, range: range)
  }

  private func setShowing(_ value: Bool, animated: Bool = true) {
    let height = value ? Self.dockHeight : 0
    let changed = showing != value || panelHeight != height
    showing = value
    panelHeight = height
    if value { isHidden = false }
    guard changed else { return }
    let apply = { self.alpha = value ? 1 : 0 }
    if animated && window != nil && !UIAccessibility.isReduceMotionEnabled {
      UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: apply) { _ in
        if !self.showing { self.isHidden = true }
      }
    } else {
      apply()
      isHidden = !value
    }
  }

  /// Hide and return to the categories, so the next trigger starts at the top.
  private func reset(animated: Bool) {
    setShowing(false, animated: animated)
    if navigation.viewControllers.count > 1 { navigation.popToRootViewController(animated: false) }
  }

  func open(input: UITextView) {
    dismissedText = nil
    input.becomeFirstResponder()
    if Self.activeRange(text: input.text ?? "", selection: input.selectedRange) == nil {
      let text = (input.text ?? "") as NSString
      let caret = input.selectedRange.location
      var prefix = ""
      if caret > 0 && text.substring(to: caret).last?.isWhitespace == false { prefix = " " }
      input.insertText(prefix + "@")
    }
    onChange?()
  }

  func finishBrowse(path: String?, selectedItem: ChatMentionItem? = nil) {
    guard let input, let draft = browserDraft else { return }
    browserDraft = nil
    guard input.text == draft.text else { return }
    if let path, let item = selectedItem ?? catalog.first(where: { $0.path == path }), item.path == path {
      insert(item, into: input, range: draft.range)
    } else {
      dismissedText = input.text
      onChange?()
    }
  }

  private func insert(_ item: ChatMentionItem, into input: UITextView, range: NSRange) {
    let text = (item.insertText ?? ("@" + item.path)) + " "
    let currentLength = ((input.text ?? "") as NSString).length
    guard NSMaxRange(range) <= currentLength, currentLength - range.length + (text as NSString).length <= 32000 else { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    applyingEdit = true
    if let composer = input as? ChatComposerInput {
      // An Agent Role reads as its emoji and name; it still sends `@role:<id>` (web).
      let label = item.kind == "role" ? ChatRoleLabel(emoji: item.emoji.flatMap { $0.isEmpty ? nil : $0 } ?? "🪼", name: item.name).text : item.kind == "session" ? "@" + item.name : nil
      composer.insertReference(String(text.dropLast()), label: label, replacing: range)
      applyingEdit = false
      onChange?()
      return
    }
    input.selectedRange = range
    input.insertText(text)
    applyingEdit = false
    input.textStorage.addAttribute(.foregroundColor, value: UIColor.lodyAccent, range: NSRange(location: range.location, length: (text as NSString).length - 1))
    input.typingAttributes[.foregroundColor] = UIColor.label
    onChange?()
  }
}

/// One level of the panel: a native list (diffable data source) on the panel's navigation stack.
/// Rows never take focus, so the prompt keeps the keyboard while the reader moves through levels.
final class ChatMentionLevelController: UIViewController, UICollectionViewDelegate {
  let level: ChatMentionLevel
  weak var panel: ChatMentionPanel?
  private var list: UICollectionView!
  private var data: UICollectionViewDiffableDataSource<Int, String>!
  private var rows: [String: ChatMentionItem] = [:]
  private static let folderRow = "\u{0}folder"

  init(level: ChatMentionLevel) {
    self.level = level
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    // Opaque, so the level being covered never shows through during the push.
    view.backgroundColor = .systemBackground
    edgesForExtendedLayout = []
    var config = UICollectionLayoutListConfiguration(appearance: .plain)
    config.backgroundColor = .clear
    config.showsSeparators = true
    list = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config))
    list.translatesAutoresizingMaskIntoConstraints = false
    list.backgroundColor = .clear
    list.keyboardDismissMode = .none
    list.contentInsetAdjustmentBehavior = .never
    list.delegate = self
    list.accessibilityIdentifier = "mention-list"
    view.addSubview(list)
    // The system bar is much too tall for a 280 pt panel; deeper levels get a compact header
    // (back chevron + title) and the stack keeps its native push / pop transitions.
    let header = level == .root ? nil : makeHeader()
    NSLayoutConstraint.activate([
      list.topAnchor.constraint(equalTo: header?.bottomAnchor ?? view.topAnchor),
      list.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      list.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      list.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    let registration = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
      guard let self else { return }
      if id == Self.folderRow, case .directory(let path) = self.level {
        var content = UIListContentConfiguration.cell()
        content.text = String.localizedStringWithFormat(
          String(localized: "native.chat.mention.directory", bundle: .lody), (path as NSString).lastPathComponent)
        content.textProperties.color = .lodyAccent
        content.textProperties.font = .dynamic(of: 16, weight: .medium)
        content.image = UIImage(systemName: "folder.badge.plus")
        content.imageProperties.tintColor = .lodyAccent
        content.imageProperties.reservedLayoutSize = CGSize(width: 32, height: 32)
        cell.contentConfiguration = content
        cell.accessories = []
        cell.accessibilityIdentifier = "mention-use-directory"
        return
      }
      guard let item = self.rows[id] else { return }
      cell.contentConfiguration = Self.content(item)
      cell.accessibilityIdentifier = "mention-item:" + item.path
      cell.accessories = item.kind == "category" || item.kind == "directory" ? [.disclosureIndicator()] : []
    }
    data = UICollectionViewDiffableDataSource(collectionView: list) { collection, indexPath, id in
      collection.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
    }
    reload(animated: false)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    navigationController?.setNavigationBarHidden(true, animated: false)
    if isViewLoaded { reload(animated: false) }
  }

  /// 44 pt (the minimum touch target, still far shorter than the system bar): a plain back
  /// chevron, the level's title, and a hairline under them.
  private func makeHeader() -> UIView {
    let header = UIView()
    header.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(header)
    let back = UIButton(type: .system)
    var config = UIButton.Configuration.plain()
    config.image = UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
    config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 8)
    back.configuration = config
    back.tintColor = .label
    back.accessibilityLabel = String(localized: "native.chat.mention.back", bundle: .lody)
    back.accessibilityIdentifier = "mention-back"
    back.addAction(UIAction { [weak self] _ in self?.navigationController?.popViewController(animated: true) }, for: .touchUpInside)
    let label = UILabel()
    label.text = title
    label.font = .dynamic(of: 15, weight: .semibold)
    label.textColor = .label
    label.lineBreakMode = .byTruncatingMiddle
    label.accessibilityTraits = .header
    let line = UIView()
    line.backgroundColor = .separator
    for child in [back, label, line] {
      child.translatesAutoresizingMaskIntoConstraints = false
      header.addSubview(child)
    }
    NSLayoutConstraint.activate([
      header.topAnchor.constraint(equalTo: view.topAnchor),
      header.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      header.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      header.heightAnchor.constraint(equalToConstant: 44),
      back.leadingAnchor.constraint(equalTo: header.leadingAnchor),
      back.topAnchor.constraint(equalTo: header.topAnchor),
      back.bottomAnchor.constraint(equalTo: header.bottomAnchor),
      back.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
      label.leadingAnchor.constraint(equalTo: back.trailingAnchor),
      label.trailingAnchor.constraint(lessThanOrEqualTo: header.trailingAnchor, constant: -16),
      label.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      line.leadingAnchor.constraint(equalTo: header.leadingAnchor),
      line.trailingAnchor.constraint(equalTo: header.trailingAnchor),
      line.bottomAnchor.constraint(equalTo: header.bottomAnchor),
      line.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
    ])
    return header
  }

  func reload(animated: Bool) {
    guard isViewLoaded, let panel else { return }
    let items = panel.rows(for: level)
    rows = Dictionary(items.map { ($0.path + "\n" + $0.kind, $0) }, uniquingKeysWith: { first, _ in first })
    var seen = Set<String>()
    // Diffable identifiers must be unique; the catalog can repeat a path.
    var ids = items.map { $0.path + "\n" + $0.kind }.filter { seen.insert($0).inserted }
    if case .directory = level, panel.query.isEmpty { ids.insert(Self.folderRow, at: 0) }
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(ids)
    snapshot.reconfigureItems(ids)
    data.apply(snapshot, animatingDifferences: animated)
    if ids.isEmpty {
      var empty = UIContentUnavailableConfiguration.empty()
      empty.text = String(localized: "native.chat.mention.empty", bundle: .lody)
      empty.textProperties.font = .dynamic(of: 15)
      empty.textProperties.color = .secondaryLabel
      contentUnavailableConfiguration = empty
    } else {
      contentUnavailableConfiguration = nil
    }
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    guard let id = data.itemIdentifier(for: indexPath), let panel else { return }
    if id == Self.folderRow, case .directory(let path) = level { return panel.chooseDirectory(path) }
    if let item = rows[id] { panel.choose(item) }
  }

  private static func content(_ item: ChatMentionItem) -> UIListContentConfiguration {
    var content = item.content
    if item.kind == "category" {
      content.secondaryText = item.subtitle.isEmpty ? nil : item.subtitle
      content.textProperties.font = .dynamic(of: 16)
      let glyph = ChatMentionItem.glyphs[item.path] ?? "folder"
      content.image = UIImage(systemName: glyph, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular))
      content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
    } else {
      if item.kind == "file" || item.kind == "directory" { content.text = (item.path as NSString).lastPathComponent }
      if item.kind == "skill" || item.kind == "cmd" { content.text = item.insertText ?? item.name }
    }
    return content
  }
}

/// Exercise the production SessionScreen/CreateSessionScreen wiring without a cloud account.
@MainActor enum MentionFixture {
  private static var creationSequence = 0
  static func response(_ payload: String, options: Bool = false) -> String? {
    guard LodyUIVerify.mentions,
          let data = payload.data(using: .utf8),
          let args = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          args["workspaceId"] as? String == "ui-home" else { return nil }
    if options {
      creationSequence += 1
      let sessionId = "ui-new-\(creationSequence)"
      if (args["projectId"] as? String)?.hasPrefix("github:") == true {
        return ##"{"sessionId":"\##(sessionId)","agents":[{"id":"fixture","name":"Fixture Agent","machineId":"ui","machineName":"Fixture Mac","cliType":"builtin","agentType":"codex"},{"id":"shared-agent","name":"Teammate Agent","machineId":"shared","machineName":"Teammate Mac","cliType":"builtin","agentType":"codex"}],"capabilities":[]}"##
      }
      return ##"{"sessionId":"\##(sessionId)","agents":[{"id":"fixture","name":"Fixture Agent","machineId":"ui","machineName":"Fixture Mac","cliType":"builtin","agentType":"codex"}],"capabilities":[]}"##
    }
    switch args["category"] as? String {
    case "skill":
      return ##"{"items":[{"path":"/fixture/skills/auth/SKILL.md","name":"auth-review","kind":"skill","subtitle":"Review authentication","insertText":"$auth-review"}],"truncated":false,"incomplete":false}"##
    case "session":
      return ##"{"items":[{"path":"ui-review","name":"Review authentication","kind":"session","subtitle":"Lody iOS","insertText":"@session:ui-review"},{"path":"ui-followup","name":"Follow up","kind":"session","subtitle":"Lody iOS","insertText":"@session:ui-followup"}],"truncated":false,"incomplete":false}"##
    case "role":
      return ##"{"items":[{"path":"role-reviewer","name":"Reviewer","kind":"role","subtitle":"Review changes and report regressions","insertText":"@role:role-reviewer"}],"truncated":false,"incomplete":false}"##
    case "issue":
      return ##"{"items":[{"path":"issue:11","name":"Mentions alignment","kind":"issue","subtitle":"LodyAI/Lody #11","insertText":"#11"}],"truncated":false,"incomplete":false}"##
    case "pr":
      return ##"{"items":[{"path":"pr:12","name":"Review implementation","kind":"pr","subtitle":"LodyAI/Lody #12","insertText":"#12"}],"truncated":false,"incomplete":false}"##
    case "cmd":
      return ##"{"items":[{"path":"compact","name":"compact","kind":"cmd","subtitle":"Compact this conversation","insertText":"/compact"}],"truncated":false,"incomplete":false}"##
    case "file":
      return ##"{"items":[{"path":"src","name":"src","kind":"directory","subtitle":""},{"path":"src/session.ts","name":"session.ts","kind":"file","subtitle":"src","insertText":"@src/session.ts"}],"truncated":true,"incomplete":false}"##
    default:
      return ##"{"items":[],"truncated":false,"incomplete":false}"##
    }
  }
}
