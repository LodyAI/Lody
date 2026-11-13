import ChatKit
import Litext
import UIKit

private final class ChatCollectionView: UICollectionView {
  var contentDidLayout: (() -> Void)?
  var selectionDidLayout: (() -> Void)?
  private var lastSize = CGSize.zero
  override func layoutSubviews() {
    super.layoutSubviews()
    selectionDidLayout?()
    guard contentSize != lastSize else { return }
    lastSize = contentSize
    contentDidLayout?()
  }

  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    if gestureRecognizer === panGestureRecognizer, let pan = gestureRecognizer as? UIPanGestureRecognizer {
      let velocity = pan.velocity(in: self)
      if abs(velocity.x) > abs(velocity.y) {
        let hit = hitTest(pan.location(in: self), with: nil)
        if hit is UIScrollView && hit !== self { return false }
      }
    }
    return super.gestureRecognizerShouldBegin(gestureRecognizer)
  }
}

private final class ChatNavigationController: UIViewController {
  var updateTitle: (() -> Void)?
  var onWillAppear: ((Bool, UIViewControllerTransitionCoordinator?) -> Void)?
  var onDidAppear: (() -> Void)?
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    onDidAppear?()
  }
  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    onWillAppear?(animated, transitionCoordinator ?? parent?.transitionCoordinator)
    updateTitle?()
  }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    updateTitle?()
  }
}

final class LodyChatView: LodyAppearanceView, UICollectionViewDelegateFlowLayout, UIGestureRecognizerDelegate, ChatSendHandoffSettling {
  var onSend: ([String: Any]) -> Void = { _ in }
  var onForkMessage: ([String: Any]) -> Void = { _ in }
  var onEditMessage: ([String: Any]) -> Void = { _ in }
  var editableMessageID = "" {
    didSet {
      for cell in collection.visibleCells {
        (cell as? ChatCell)?.updateEditAccessibility()
        (cell as? ChatMessageAttachmentsCell)?.updateEditAccessibility()
      }
    }
  }
  var editedMessageID = "" { didSet { scrollToEditedMessage() } }
  func scrollToEditedMessage() {
    guard !editedMessageID.isEmpty, !applying,
      let row = dataSource.snapshot().itemIdentifiers.compactMap({ rows[$0] }).first(where: { $0.entryID == editedMessageID }),
      let index = dataSource.indexPath(for: row.id) else { return }
    editedMessageID = ""
    pauseTracking()
    collection.scrollToItem(at: index, at: .top, animated: false)
  }
  var onStop: ([String: Any]) -> Void = { _ in }
  var onSteer: ([String: Any]) -> Void = { _ in }
  var onErrorRetry: ([String: Any]) -> Void = { _ in }
  var onPlanDecision: ([String: Any]) -> Void = { _ in }
  /// Accept (`true`) or dismiss an Agent's proposal row; the owner reports back through `setProposalState`.
  var onProposalDecision: (_ row: ChatRow, _ accept: Bool) -> Void = { _, _ in }
  var onProposalOpenSchedule: (String) -> Void = { _ in }
  /// Decisions in flight or failed, by `entryId/itemId`.
  var proposalStates: [String: ChatProposalState] = [:]
  /// The signed-in user: a Role proposal is decided only by the member who asked for it.
  var proposalUserID = ""
  var planDecisionState: ChatPlanDecisionState?
  var errorRetryState: ChatErrorRetryState?
  var onActivityPress: ([String: Any]) -> Void = { _ in }
  var onTurnInfoPress: ([String: Any]) -> Void = { _ in }
  weak var messageDetailsPage: MessageDetailsController?
  var turnInfoEnabled = false
  var onFilePress: ([String: Any]) -> Void = { _ in }
  /// Opens a GitHub PR link in the native PR page; false leaves it to the browser.
  var onPullRequestLink: (ChatPullRequestLink) -> Bool = { _ in false }
  var onTurnChangesPress: ([String: Any]) -> Void = { _ in }
  var onReconnect: ([String: Any]) -> Void = { _ in }
  var onRetrySend: ([String: Any]) -> Void = { _ in }
  var onTitlePress: ([String: Any]) -> Void = { _ in }
  var onPreview: ([String: Any]) -> Void = { _ in }
  private let simulatorPreview = SimulatorPreview(frame: .zero)

  func setSimulatorPreview(_ json: String) {
    simulatorPreview.setSource(json)
  }
  var onTitleMenu: ([String: Any]) -> Void = { _ in }
  var onComposerOptionChange: ([String: Any]) -> Void = { _ in }
  var onMentionBrowse: ([String: Any]) -> Void = { _ in }
  let titleButton = ChatNavigationTitleButton()
  var pageOwnsHeader = false { didSet { composer.fullScreenTopInset = pageHeaderHeight } }
  var pageHeaderHeight: CGFloat { pageOwnsHeader ? 56 : 0 }
  var tabsAnchorView: UIView { titleButton }
  private var navigationTitle = ""
  private var navigationSubtitle = ""
  private var navigationMachine = ""
  private var navigationMachineState = ""
  private var navigationBranch = ""
  private let navigation = ChatNavigationController()
  let findClip = CALayer()
  let collection: UICollectionView
  let measuringText = CKTextView()
  var measurements: [String: (width: CGFloat, text: NSAttributedString, height: CGFloat)] = [:]
  let store = ChatMarkdownStore(traits: .current)
  var markdownSelections: [String: TextSelectionGroup] = [:]
  let findBar = ChatFindBar()
  var findPresented = false
  var lastFindRequest = ""
  var findMatches: [ChatFindMatch] = []
  var findSelection: ChatFindMatch?
  var findNeedsInitialPosition = false
  var findFocusRequest: Bool?
  let findHighlightedViews = NSHashTable<UIView>.weakObjects()
  var composer = ChatComposerView(frame: .zero)
  var composerBottom: NSLayoutConstraint!
  var composerRetired = false
  let edgeFade = LodyEdgeFade()
  let overlay = ChatOverlay()
  var localAttachments: [String: [ChatMessageAttachment]] = [:]
  var expandedPlans = Set<String>()
  var expandedMessages = Set<String>()
  /// Finished turns whose "Worked for …" fold the reader opened in place.
  var expandedWork = Set<String>()
  var expandedThoughts = Set<String>()
  /// A row the reader just toggled: the next layout keeps it where it was on screen.
  var toggleAnchor: String?
  var expandedAttachments = Set<String>()
  var imageWorkspace = ""
  var imageSession = ""
  weak var imagePreview: ChatImagePreview?
  /// Each image stack's top image, kept across cell reuse and preview paging.
  var imageStackTops: [String: String] = [:]
  var mentionRepository = "" {
    didSet {
      guard oldValue != mentionRepository else { return }
      refreshTextRendering()
    }
  }
  let empty = UILabel()
  private weak var scrollOwner: UIViewController?
  var dataSource: UICollectionViewDiffableDataSource<String, String>!
  var members: [String: WorkspaceMember] = [:] {
    // Member refreshes do not enqueue new message JSON. Reproject the existing rows directly.
    didSet { if members != oldValue { applyRows() } }
  }
  var transcript = ChatTranscript()
  var operationCurrentID = ""
  var operationTitles: [String: String] = [:]
  var operationRoots: [String: String] = [:]
  var operationOpened = Set<String>()
  var operationAgentTypes: [String: String] = [:]
  var operationCLITypes: [String: String] = [:]
  var expandedOperations = Set<String>()
  var onOperationOpen: (String) -> Void = { _ in }
  var onOperationReply: (ChatOperationCard, String) -> Void = { _, _ in }
  /// Builtin DSH only (web `showThoughts`): its thoughts stay in the transcript.
  var showsThoughts = false
  var processEntryID = ""
  var processStartID = ""
  var stream = ChatStream()
  // Frozen presentation only. ChatStream keeps accepting authoritative updates.
  var deferredRows: [String: [ChatRow]] = [:]
  var catchingUpEntries: Set<String> = []
  var frameTimer: Timer?
  var rendering = false
  var framePending = false
  var lastRenderTime = 0.0
  var renderTailLength = 0
  var rows: [String: ChatRow] = [:]
  var pendingEntries: (json: String, animate: Bool)?
  var pendingSnapshotEntries: Set<String> = []
  var snapshotEntries: Set<String> = []
  var preparedEntries: PreparedChatEntries?
  var workDurationTimer: Timer?
  let preparation = DispatchQueue(label: "ai.lody.mobile.chat", qos: .userInitiated)
  var decoding = false
  var displayError: String? { didSet { composer.displayError = displayError } }
  var applying = false
  var needsApply = false
  var needsTextRefresh = false
  var historyPreparation: DispatchWorkItem?
  var historyStartID: String?
  var historyTargetID: String?
  var historyLayoutAnchor: (String, CGFloat)?
  var scrollingToTop = false
  var hasEarlierHistory = false
  var remoteHasEarlierHistory = false
  var remoteHistoryLoading = false
  var historyFirstID: String?
  var onLoadEarlierHistory: () -> Void = {}
  var hasPagedHistory = false
  var preparingHistory = false
  var preparedHistory: [String: ChatRow] = [:]
  var historyWidth: CGFloat = 0
  var followsBottom = true
  var trackingPausedByGesture = false
  var liveEntryID: String?
  let turnFeedback = UINotificationFeedbackGenerator()
  let replyHaptics = ChatReplyHaptics()
  var replyText: (entryID: String, length: Int)?
  var lastUserID: String?
  var anchoredUserID: String?
  var awaitingUserAnchor = false
  var motionLink: CADisplayLink?
  var motionTime: CFTimeInterval = 0
  var movingLayout = false
  var hasPositionedContent = false
  var deliveryExits: [String: CGFloat] = [:]
  var rowHeights: [String: (current: CGFloat, target: CGFloat, width: CGFloat)] = [:]
  var historyLoadStarted = 0.0
  var historyFirstContent = 0.0
  var historyFirstRows = 0
  var historySliceTimes: [Double] = []
  var historyPages: [[String: Any]] = []
  var historyAnchorError: CGFloat = 0
  var scrollProbe: ChatScrollProbe?
  var performanceProbe: ChatPerformanceProbe?
  var streamPerformanceProbe: ChatStreamPerformanceProbe?
  private var laidOutHeight: CGFloat = 0
  private var hasInitialDraft = false
  var pendingSend: ChatPendingSend?
  var turnStartedAt: [String: Double] = [:]
  var publishedPendingID: String?
  var handoffID: String?
  var sendScroll: (started: CFTimeInterval, offset: CGFloat)?
  var hasAppeared = false
  var composerHasAcknowledgedSend = false
  private var lastAcknowledgedDraftToken = 0
  private var lastRestoredDraftToken = 0
  /// One row of the turn's output card. Tasks and changed files share it, so the card reads as
  /// one component: a leading glyph (a spinner while tasks run), the title, an optional second
  /// line, an optional trailing detail, and the system disclosure — each row opens its own sheet.
  /// A state change on a visible row cross-fades instead of snapping.
  private static func configureOutputRow(_ cell: ChatFileCell, row: ChatRow, symbol: String, live: Bool, trailing: UIView?) {
    var content = ChatFileCell.headerContent(for: row.text)
    if !live { content.image = UIImage(systemName: symbol) }
    content.imageProperties.tintColor = .secondaryLabel
    content.imageProperties.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .subheadline, scale: .small)
    content.imageProperties.reservedLayoutSize = CGSize(width: 22, height: 0)
    if !row.detail.isEmpty {
      content.secondaryText = row.detail
      content.secondaryTextProperties.font = .preferredFont(forTextStyle: .caption1)
      content.secondaryTextProperties.color = .tertiaryLabel
      content.secondaryTextProperties.numberOfLines = 1
    }
    if cell.window != nil {
      UIView.transition(with: cell.contentView, duration: 0.25, options: [.transitionCrossDissolve, .allowUserInteraction]) {
        cell.contentConfiguration = content
      }
    } else {
      cell.contentConfiguration = content
    }
    cell.apply(group: row.group, selected: false)
    var accessories: [UICellAccessory] = []
    if let trailing { accessories.append(.customView(configuration: .init(customView: trailing, placement: .trailing()))) }
    accessories.append(.disclosureIndicator())
    if live {
      let spinner = UIActivityIndicatorView(style: .medium)
      spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
      spinner.startAnimating()
      accessories.append(.customView(configuration: .init(customView: spinner, placement: .leading(), reservedLayoutWidth: .custom(22))))
    }
    cell.accessories = accessories
    cell.configurationUpdateHandler = { cell, state in
      (cell as? ChatFileCell)?.apply(group: row.group, selected: state.isHighlighted)
    }
    cell.isAccessibilityElement = true
    cell.accessibilityIdentifier = row.id
    cell.accessibilityTraits = .button
  }

  /// The output card's changed-files row: the document glyph, "3 files" and the +/− totals; it
  /// opens the files sheet (`TurnFilesController`), where a file pushes its diff.
  private let fileHeaderRegistration = UICollectionView.CellRegistration<ChatFileCell, ChatRow> { cell, _, row in
    var counts: UILabel?
    if let file = row.fileDiff {
      let label = UILabel()
      label.font = LodyDesign.mono(12, compatibleWith: cell.traitCollection)
      let value = NSMutableAttributedString(string: "+\(file.add ?? 0)", attributes: [.foregroundColor: UIColor.systemGreen])
      value.append(NSAttributedString(string: "  −\(file.del ?? 0)", attributes: [.foregroundColor: UIColor.systemRed]))
      label.attributedText = value
      counts = label
    }
    LodyChatView.configureOutputRow(cell, row: row, symbol: "doc.text", live: false, trailing: counts)
    if let file = row.fileDiff {
      cell.accessibilityLabel = String.localizedStringWithFormat(String(localized: "native.chat.file.diffStats", bundle: .lody), String(describing: file.add ?? 0), String(describing: file.del ?? 0), String(describing: row.text))
    }
  }

  /// The output card's tasks row: a live spinner or the stack glyph, the count, and the newest
  /// running task's latest step; it opens the task sheet (`TasksController`).
  private let taskHeaderRegistration = UICollectionView.CellRegistration<ChatFileCell, ChatRow> { cell, _, row in
    LodyChatView.configureOutputRow(cell, row: row, symbol: "square.stack.3d.up", live: row.running, trailing: nil)
    cell.accessibilityLabel = [row.text, row.detail].filter { !$0.isEmpty }.joined(separator: ", ")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    let layout = ChatCollectionLayout()
    layout.minimumLineSpacing = 0
    layout.minimumInteritemSpacing = 0
    layout.sectionInset = UIEdgeInsets(
      top: ChatReadingColumn.sectionTop,
      left: ChatReadingColumn.cellMargin,
      bottom: ChatReadingColumn.sectionBottom,
      right: ChatReadingColumn.cellMargin
    )
    let collection = ChatCollectionView(frame: .zero, collectionViewLayout: layout)
    self.collection = collection
    super.init(frame: frame)
    titleButton.accessibilityIdentifier = "chat-navigation-title"
    titleButton.accessibilityHint = nil
    titleButton.isUserInteractionEnabled = true
    titleButton.addAction(UIAction { [weak self] _ in self?.onTitlePress([:]) }, for: .touchUpInside)
    titleButton.accessibilityTraits = [.header, .button]
    navigation.view = UIView(frame: .zero)
    navigation.view.isUserInteractionEnabled = false
    navigation.updateTitle = { [weak self] in self?.attachTitle() }
    navigation.onDidAppear = { [weak self] in
      self?.hasAppeared = true
      self?.adoptComposerIfNeeded()
      self?.deliverPendingContent()
    }
    navigation.onWillAppear = { [weak self] animated, coordinator in
      self?.deselectFileOnReturn(animated: animated, coordinator: coordinator)
    }
    backgroundColor = .lodyBackground
    registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (view: LodyChatView, _: UITraitCollection) in
      view.backgroundColor = view.processBackground
    }
    collection.backgroundColor = .clear
    collection.accessibilityIdentifier = "chat-transcript"
    collection.alwaysBounceVertical = true
    collection.keyboardDismissMode = .interactive
    let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
    tap.cancelsTouchesInView = false
    tap.delegate = self
    collection.addGestureRecognizer(tap)
    collection.contentInsetAdjustmentBehavior = .automatic
    collection.delegate = self
    collection.selectionDidLayout = { [weak self] in self?.refreshMarkdownSelections() }
    collection.contentDidLayout = { [weak self] in
      guard let self, !self.applying, !self.movingLayout else { return }
      self.updateBottomInset()
      if self.followsBottom { self.scrollToBottom() }
      self.refreshFindHighlights()
    }
    collection.register(ChatMessageAttachmentsCell.self, forCellWithReuseIdentifier: "attachments")
    collection.register(ChatImageCell.self, forCellWithReuseIdentifier: "image")
    collection.register(ChatImageStackCell.self, forCellWithReuseIdentifier: "image-stack")
    collection.register(ChatHistoryHeader.self, forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader, withReuseIdentifier: "history")
    collection.register(ChatErrorCell.self, forCellWithReuseIdentifier: "error")
    collection.register(ChatProposalCell.self, forCellWithReuseIdentifier: "proposal")
    collection.register(ChatFileCardCell.self, forCellWithReuseIdentifier: "file-card")
    collection.register(ChatOperationCell.self, forCellWithReuseIdentifier: "operation")
    collection.register(ChatSubagentCell.self, forCellWithReuseIdentifier: "subagent")
    collection.register(ChatCell.self, forCellWithReuseIdentifier: "message")
    collection.register(ChatMessageActionsCell.self, forCellWithReuseIdentifier: "meta")
    collection.register(ChatPlanCell.self, forCellWithReuseIdentifier: "proposed-plan")
    collection.register(ChatMarkdownCell.self, forCellWithReuseIdentifier: "markdown")
    dataSource = UICollectionViewDiffableDataSource<String, String>(collectionView: collection) { [weak self] collection, index, id in
      guard let self, let row = self.rows[id] else { return nil }
      if row.kind == "chat_failed" {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "error", for: index) as! ChatErrorCell
        cell.configure(row)
        cell.onDetail = { [weak self] in self?.onActivityPress(["entryId": row.entryID, "itemId": row.itemID]) }
        cell.onRetry = { [weak self] in self?.onErrorRetry(["entryId": row.entryID, "itemId": row.itemID, "id": UUID().uuidString.lowercased()]) }
        return cell
      }
      if row.kind == "proposal" {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "proposal", for: index) as! ChatProposalCell
        cell.configure(row)
        cell.onDecision = { [weak self] accept in self?.onProposalDecision(row, accept) }
        cell.onOpenSchedule = { [weak self] id in self?.onProposalOpenSchedule(id) }
        return cell
      }
      if row.kind == "file", row.file != nil {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "file-card", for: index) as! ChatFileCardCell
        cell.configure(row)
        return cell
      }
      if row.kind.hasPrefix("operation") {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "operation", for: index) as! ChatOperationCell
        cell.configure(row)
        cell.onOpen = { [weak self] in
          if row.actionable, let card = row.operation { self?.onOperationOpen(card.sessionId) }
        }
        cell.onReply = { [weak self] in
          if let card = row.operation { self?.onOperationReply(card, row.text) }
        }
        cell.onPeerOpen = { [weak self] peer in
          if peer.actionable { self?.onOperationOpen(peer.card.sessionId) }
        }
        cell.onPeerReply = { [weak self] peer in self?.onOperationReply(peer.card, peer.text) }
        cell.onToggle = { [weak self] in
          guard let self, row.actionable else { return }
          let group = row.entryID + ":" + row.itemID
          if !expandedOperations.insert(group).inserted { expandedOperations.remove(group) }
          toggleAnchor = row.id
          followsBottom = false
          applyRows()
        }
        return cell
      }
      if row.subagent != nil {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "subagent", for: index) as! ChatSubagentCell
        cell.configure(row)
        return cell
      }
      if row.kind == "meta" {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "meta", for: index) as! ChatMessageActionsCell
        let text = ChatMessageShare.content(in: self.transcript, entryID: row.entryID)?.text ?? ""
        cell.configure(row, copyable: !text.isEmpty)
        cell.detailsButton.isHidden = !turnInfoEnabled
        cell.onCopy = { UIPasteboard.general.setMessageMarkdown(text) }
        cell.forkButton.removeAction(identifiedBy: .init("fork"), for: .touchUpInside)
        cell.forkButton.addAction(UIAction(identifier: .init("fork")) { [weak self] _ in self?.onForkMessage(["entryId": row.entryID]) }, for: .touchUpInside)
        cell.detailsButton.removeAction(identifiedBy: .init("turn-info"), for: .touchUpInside)
        cell.detailsButton.addAction(UIAction(identifier: .init("turn-info")) { [weak self] _ in
          guard let self else { return }
          let page = MessageDetailsController(entryId: row.entryID, entry: self.transcript.entries.first { $0.id == row.entryID })
          self.messageDetailsPage = page
          LodyShell.shared.presentNative(page, title: String(localized: "message.details.title", bundle: .lody), detents: [0.75, 1], grabber: true)
          self.onTurnInfoPress(["entryId": row.entryID])
        }, for: .touchUpInside)
        return cell
      }
      if row.kind == "changesHeader" {
        return collection.dequeueConfiguredReusableCell(using: self.fileHeaderRegistration, for: index, item: row)
      }
      if row.kind == "tasksHeader" {
        return collection.dequeueConfiguredReusableCell(using: self.taskHeaderRegistration, for: index, item: row)
      }
      if row.kind == "attachments" {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "attachments", for: index) as! ChatMessageAttachmentsCell
        cell.canEdit = { [weak self] in self?.editableMessageID == row.entryID }
        cell.onEdit = { [weak self] in self?.onEditMessage(["entryId": row.entryID]) }
        cell.configure(row, workspace: self.imageWorkspace, session: self.imageSession, expanded: self.expandedAttachments.contains(row.entryID))
        cell.onToggle = { [weak self] in self?.toggleExpansion(row) }
        cell.onPreview = { [weak self] attachment, image in
          guard let self else { return }
          if let image, let id = image.accessibilityIdentifier, !id.isEmpty {
            self.openImageGallery(id: id, source: image)
            return
          }
          self.openAttachment(attachment)
        }
        return cell
      }
      if row.kind == "imageStack" {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "image-stack", for: index) as! ChatImageStackCell
        cell.configure(row, topID: self.imageStackTops[row.id], workspace: self.imageWorkspace, session: self.imageSession)
        cell.onTopChange = { [weak self] top in self?.imageStackTops[row.id] = top }
        return cell
      }
      if row.image != nil {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "image", for: index) as! ChatImageCell
        cell.configure(row, workspace: self.imageWorkspace, session: self.imageSession)
        return cell
      }
      if row.kind == "proposed_plan" {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "proposed-plan", for: index) as! ChatPlanCell
        let width = max(1, ChatReadingColumn.itemWidth(in: collection.bounds.width) - 32)
        let markdown = self.store.view(id: id, text: row.text, secondary: false, streaming: row.streaming, width: width)
        markdown.onLink = { [weak self] in self?.openMessageLink($0) }
        cell.configure(row, markdown: markdown, expanded: self.expandedPlans.contains(id))
        cell.onToggle = { [weak self] in self?.toggleExpansion(row) }
        cell.onDecision = { [weak self] action in self?.onPlanDecision(["entryId": row.entryID, "itemId": row.itemID, "action": action, "id": UUID().uuidString.lowercased()]) }
        cell.onReview = { [weak self] in self?.onActivityPress(["entryId": row.entryID, "itemId": row.planPermissionItemID]) }
        return cell
      }
      if row.kind == "text" || row.kind == "thought" {
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "markdown", for: index) as! ChatMarkdownCell
        let secondary = row.kind == "thought"
        cell.onLink = { [weak self] in self?.openMessageLink($0) }
        let width = ChatCell.textWidth(row, width: ChatReadingColumn.itemWidth(in: collection.bounds.width))
        cell.configure(
          row,
          markdown: self.store.view(id: id, text: row.text, secondary: secondary, streaming: row.streaming, width: width),
          previousKind: self.kind(before: id)
        )
        return cell
      }
      let cell = collection.dequeueReusableCell(withReuseIdentifier: "message", for: index) as! ChatCell
      cell.onInteraction = { [weak self] in self?.pauseTracking() }
      cell.canEdit = { [weak self] in self?.editableMessageID == row.entryID && row.kind == "user" }
      cell.onEdit = { [weak self] in self?.onEditMessage(["entryId": row.entryID]) }
      cell.label.onLink = row.kind == "user" ? { [weak self] in self?.openMessageLink($0) } : nil
      cell.onToggle = { [weak self] in self?.toggleExpansion(row) }
      cell.onActivate = { [weak self] in
        guard let self, let index = self.dataSource.indexPath(for: row.id) else { return }
        self.collectionView(self.collection, didSelectItemAt: index)
      }
      cell.expanded = self.expandedMessages.contains(row.entryID)
      cell.configure(row, text: self.text(for: row))
      return cell
    }
    LodyScrollEdges.chat(collection)
    dataSource.supplementaryViewProvider = { [weak self] collection, kind, index in
      let header = collection.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: "history", for: index) as! ChatHistoryHeader
      if let self {
        header.configure(loading: self.preparingHistory || self.remoteHistoryLoading, hasEarlier: self.hasEarlierHistory)
        header.load = { [weak self] in self?.loadEarlierHistory() }
      }
      return header
    }
    composer.onSend = { [weak self] payload in
      guard let self else { return }
      if let data = try? JSONSerialization.data(withJSONObject: payload.merging(["status": String(localized: "native.chat.status.sending", bundle: .lody)]) { _, new in new }),
         let pending = try? JSONDecoder().decode(ChatPendingSend.self, from: data) {
        self.setPendingSend(pending)
      }
      if payload["queue"] as? Bool != true {
        self.awaitingUserAnchor = payload["guide"] as? Bool != true
        self.trackingPausedByGesture = false
        self.followsBottom = true
      }
      self.onSend(payload)
    }
    composer.onStop = { [weak self] in self?.onStop([:]) }
    composer.onSteer = { [weak self] in self?.onSteer(["id": $0]) }
    composer.onReconnect = { [weak self] in self?.onReconnect([:]) }
    composer.onPreview = { [weak self] in self?.onPreview(["action": $0]) }
    addSubview(simulatorPreview)
    simulatorPreview.onAction = { [weak self] in self?.onPreview(["action": $0]) }
    composer.onMentionBrowse = { [weak self] in self?.onMentionBrowse($0) }
    composer.onComposerOptionChange = { [weak self] in self?.onComposerOptionChange($0) }
    empty.numberOfLines = 0
    empty.textAlignment = .center
    empty.font = .dynamic(of: 16)
    empty.textColor = .secondaryLabel
    empty.text = String(localized: "native.chat.empty.loading", bundle: .lody)
    collection.backgroundView = empty
    addSubview(collection)
    addSubview(edgeFade)
    addSubview(composer)
    overlay.onReconnect = { [weak self] in self?.onReconnect([:]) }
    overlay.onScrollToBottom = { [weak self] in
      guard let self else { return }
      self.scrollingToTop = false
      self.collection.setContentOffset(self.collection.contentOffset, animated: false)
      self.trackingPausedByGesture = false
      self.followsBottom = true
      if !self.updateDeferredStreams() { self.scrollToBottom() }
    }
    addSubview(overlay)
    addSubview(findBar)
    if LodyUIVerify.enabled { addSubview(ChatFindProbe()) }
    overlay.translatesAutoresizingMaskIntoConstraints = false
    collection.translatesAutoresizingMaskIntoConstraints = false
    edgeFade.translatesAutoresizingMaskIntoConstraints = false
    composer.translatesAutoresizingMaskIntoConstraints = false
    composer.allowsFullScreen = true
    let composerWidth = composer.widthAnchor.constraint(equalTo: safeAreaLayoutGuide.widthAnchor)
    composerWidth.priority = .defaultHigh
    NSLayoutConstraint.activate([
      overlay.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 16),
      overlay.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -16),
      overlay.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -8),
      overlay.heightAnchor.constraint(equalToConstant: ChatOverlay.controlSize),
      collection.topAnchor.constraint(equalTo: topAnchor),
      collection.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor),
      collection.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor),
      collection.bottomAnchor.constraint(equalTo: bottomAnchor),
      edgeFade.topAnchor.constraint(equalTo: composer.topAnchor, constant: -LodyEdgeFade.overlap),
      edgeFade.leadingAnchor.constraint(equalTo: leadingAnchor),
      edgeFade.trailingAnchor.constraint(equalTo: trailingAnchor),
      edgeFade.bottomAnchor.constraint(equalTo: bottomAnchor),
      composer.centerXAnchor.constraint(equalTo: safeAreaLayoutGuide.centerXAnchor),
      composer.widthAnchor.constraint(lessThanOrEqualToConstant: ChatReadingColumn.maximumWidth),
      composerWidth,
    ])
    composerBottom = composer.bottomAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor)
    composerBottom.isActive = true
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layoutFind()
    simulatorPreview.layout(in: CGRect(
      x: safeAreaInsets.left, y: safeAreaInsets.top + pageHeaderHeight,
      width: bounds.width - safeAreaInsets.left - safeAreaInsets.right,
      height: max(0, composer.frame.minY - safeAreaInsets.top - pageHeaderHeight - 40)))
    bringSubviewToFront(simulatorPreview)
    adoptComposerIfNeeded()
    bindScrollOwnerIfNeeded()
    attachTitle()
    updateBottomButton()
    if updateBottomInset(), followsBottom { scrollToBottom() }
    deliverPendingContent()
    if abs(laidOutHeight - collection.bounds.height) > 0.5 {
      laidOutHeight = collection.bounds.height
      if followsBottom { scrollToBottom() }
    }
  }

  func setNavigationTitle(_ title: String) {
    guard navigationTitle != title else { return }
    navigationTitle = title
    updateTitleButton()
  }

  private var directoryTabSymbol: String?

  func setDirectoryTabs(_ caption: String, symbol: String) {
    directoryTabSymbol = symbol
    navigationSubtitle = caption
    navigationMachine = ""
    navigationMachineState = ""
    navigationBranch = ""
    updateTitleButton()
  }

  func setTitleMenu(_ json: String) {
    struct Item: Decodable {
      let id: String
      let title: String
      var subtitle: String?
      let symbol: String
      var group: Int?
      var destructive: Bool?
      var selected: Bool?
      var disabled: Bool?
    }
    let items = (try? JSONDecoder().decode([Item].self, from: Data(json.utf8))) ?? []
    let groups = Dictionary(grouping: items) { $0.group ?? 0 }
    titleButton.menu = items.isEmpty ? nil : UIMenu(children: groups.keys.sorted().map { key in
      UIMenu(options: .displayInline, children: groups[key]!.map { item in
        UIAction(title: item.title, subtitle: item.subtitle, image: UIImage(systemName: item.symbol),
                 attributes: item.disabled == true ? .disabled : (item.destructive == true ? .destructive : []), state: item.selected == true ? .on : .off) { [weak self] _ in
          self?.onTitleMenu(["id": item.id])
        }
      })
    })
    titleButton.showsMenuAsPrimaryAction = !items.isEmpty
  }

  func setNavigationSubtitle(_ subtitle: String) {
    guard navigationSubtitle != subtitle else { return }
    navigationSubtitle = subtitle
    updateTitleButton()
  }

  func setNavigationMachine(_ name: String) {
    guard navigationMachine != name else { return }
    navigationMachine = name
    updateTitleButton()
  }
  func setNavigationMachineState(_ state: String) {
    guard navigationMachineState != state else { return }
    navigationMachineState = state
    updateTitleButton()
  }

  func setNavigationBranch(_ name: String) {
    let branch = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard navigationBranch != branch else { return }
    navigationBranch = branch
    updateTitleButton()
  }

  private func titleSubtitle() -> String {
    ChatNavigationTitle.plainSubtitle(project: navigationSubtitle, machine: navigationMachine, branch: navigationBranch)
  }

  private func updateTitleButton() {
    ChatNavigationTitle.configureButton(
      titleButton,
      title: navigationTitle,
      subtitle: navigationSubtitle,
      machine: navigationMachine,
      branch: navigationBranch,
      machineState: navigationMachineState, tabSymbol: directoryTabSymbol
    )
    attachTitle()
  }

  private func bindScrollOwnerIfNeeded() {
    guard window != nil, scrollOwner == nil else { return }
    var responder = next
    while let current = responder {
      if let controller = current as? UIViewController {
        LodyScrollEdges.bind(collection, to: controller)
        LodyScrollEdges.chat(collection)
        scrollOwner = controller
        if navigation.parent == nil {
          controller.addChild(navigation)
          addSubview(navigation.view)
          navigation.didMove(toParent: controller)
        }
        break
      }
      responder = current.next
    }
  }

  private func attachTitle() {
    bindScrollOwnerIfNeeded()
    guard window != nil, let owner = scrollOwner else { return }
    guard !pageOwnsHeader else { return }
    guard !navigationTitle.isEmpty || !navigationSubtitle.isEmpty || !navigationMachine.isEmpty || !navigationBranch.isEmpty else {
      ChatNavigationTitle.detach(button: titleButton, from: owner.navigationItem)
      return
    }
    ChatNavigationTitle.apply(
      title: navigationTitle,
      subtitle: titleSubtitle(),
      button: titleButton,
      to: owner.navigationItem
    )
  }

  override func willMove(toSuperview newSuperview: UIView?) {
    if newSuperview == nil, navigation.parent != nil {
      navigation.willMove(toParent: nil)
      navigation.view.removeFromSuperview()
      navigation.removeFromParent()
    }
    super.willMove(toSuperview: newSuperview)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    guard previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory
      || previousTraitCollection?.userInterfaceStyle != traitCollection.userInterfaceStyle
      || previousTraitCollection?.accessibilityContrast != traitCollection.accessibilityContrast else { return }
    refreshTextRendering()
  }

  // Off-window views have no size class yet; fall back to the idiom until the
  // window reports one.
  var processBackground: UIColor {
    guard !processEntryID.isEmpty else { return .lodyBackground }
    switch window?.traitCollection.horizontalSizeClass ?? .unspecified {
    case .compact: return .clear
    case .regular: return .lodyBackground
    default: return traitCollection.userInterfaceIdiom == .phone ? .clear : .lodyBackground
    }
  }

  override func lodyAppearanceDidChange() {
    backgroundColor = processBackground
    edgeFade.color = .lodyBackground
    refreshTextRendering()
  }

  private func refreshTextRendering() {
    store.apply(traits: traitCollection)
    preparedHistory.removeAll()
    measurements.removeAll()
    empty.font = .dynamic(of: 16, compatibleWith: traitCollection)
    guard dataSource != nil else { return }
    guard !applying else { needsTextRefresh = true; return }
    var snapshot = dataSource.snapshot()
    let ids = snapshot.itemIdentifiers
    if !ids.isEmpty {
      applying = true
      snapshot.reconfigureItems(ids)
      dataSource.apply(snapshot, animatingDifferences: false)
      applying = false
      if needsApply || needsTextRefresh {
        DispatchQueue.main.async { [weak self] in self?.drainChatUpdates() }
      }
    }
    collection.collectionViewLayout.invalidateLayout()
    setNeedsLayout()
  }

  func drainChatUpdates() {
    guard !applying else { return }
    if needsTextRefresh {
      needsTextRefresh = false
      refreshTextRendering()
    }
    if needsApply {
      needsApply = false
      applyRows()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    backgroundColor = processBackground
    if window == nil {
      for group in markdownSelections.values { group.labels = [] }
      markdownSelections.removeAll()
      scrollingToTop = false
      historyPreparation?.cancel(); historyPreparation = nil
      if let handoffID { ChatSendHandoff.cancel(id: handoffID) }
      motionLink?.invalidate(); motionLink = nil
      rowHeights.removeAll()
      deliveryExits.removeAll()
      scrollProbe?.stop(); scrollProbe = nil
      performanceProbe?.stop(); performanceProbe = nil
      streamPerformanceProbe?.stop(); streamPerformanceProbe = nil
      liveEntryID = nil
      frameTimer?.invalidate(); frameTimer = nil
      workDurationTimer?.invalidate(); workDurationTimer = nil
      stream.finish()
      if let owner = scrollOwner {
        ChatNavigationTitle.detach(button: titleButton, from: owner.navigationItem)
      }
      if scrollOwner?.contentScrollView(for: .top) === collection {
        scrollOwner?.setContentScrollView(nil, for: .top)
        scrollOwner?.setContentScrollView(nil, for: .bottom)
      }
      scrollOwner = nil
    } else {
      if LodyUIVerify.scroll {
        scrollProbe = ChatScrollProbe(self)
      }
      bindScrollOwnerIfNeeded()
      attachTitle()
      if pendingEntries != nil { scheduleUpdate() }
      renderFrame()
    }
  }

  @objc private func dismissKeyboard() { endEditing(true) }
  func openMessageLink(_ href: String) {
    pauseTracking()
    if let target = ChatFileLink(href) {
      onFilePress(["path": target.path, "line": target.line ?? 0])
    } else if let pr = ChatPullRequestLink(href), onPullRequestLink(pr) {
      return
    } else if let url = URL(string: href), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
      UIApplication.shared.open(url)
    }
  }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    // Row actions own their tap. Dismissing the keyboard first moves the row
    // before UICollectionView can deliver selection (notably Retry).
    if let index = collection.indexPathForItem(at: touch.location(in: collection)),
       let id = dataSource.itemIdentifier(for: index), rows[id]?.actionable == true { return false }
    return !(touch.view is UITextView)
  }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
  func setDraftKey(_ key: String) {
    guard !key.isEmpty else { composer.onDraftChange = nil; return }
    let store = LocalStore.shared
    composer.onDraftChange = { text in
      LocalStore.queue.async { try? store.write(key, text) }
    }
    LocalStore.queue.async { [weak self] in
      guard let text = try? store.read(key), !text.isEmpty else { return }
      DispatchQueue.main.async { self?.composer.setStoredDraft(text) }
    }
  }

  func setPendingSendJSON(_ json: String) {
    guard !json.isEmpty else {
      // A stale initial empty prop must not erase a send handled in this native frame.
      if let publishedPendingID, let pendingSend, pendingSend.id == publishedPendingID {
        if LodyComposerView.relays[pendingSend.id] != nil {
          composerHasAcknowledgedSend = true
          self.publishedPendingID = nil
          return
        }
        composer.clearPendingSend(id: publishedPendingID)
        composerHasAcknowledgedSend = true
        // entriesJSON is decoded off-main. Keep the local rows until the same
        // authoritative rows arrive, even if the pending state is cleared first.
        if pendingSend.rows(entries: transcript.entries).isEmpty && (pendingSend.queue != true || transcript.entries.contains(where: { $0.id == pendingSend.id })) { self.pendingSend = nil }
        self.publishedPendingID = nil
        applyRows()
      }
      return
    }
    guard let value = try? JSONDecoder().decode(ChatPendingSend.self, from: Data(json.utf8)), !value.id.isEmpty else { return }
    publishedPendingID = value.id
    if LodyComposerView.relays[value.id] != nil {
      pendingSend = value
      adoptComposerIfNeeded()
      return
    }
    composer.setPendingSend(value)
    setPendingSend(value)
  }

  func setPendingSend(_ pending: ChatPendingSend) {
    var value = pending
    if value.displayText == nil, pendingSend?.id == value.id {
      value.displayText = pendingSend?.displayText
      value.references = pendingSend?.references
    }
    var start = turnStartedAt[value.id]
    if start == nil, let supplied = value.startedAt, supplied.isFinite {
      start = supplied
    }
    if start == nil {
      start = Date().timeIntervalSince1970 * 1000
    }
    value.startedAt = start
    turnStartedAt[value.id] = start
    let changed = pendingSend?.id != value.id
    pendingSend = value
    if changed { composerHasAcknowledgedSend = false }
    if changed && value.queue != true {
      handoffID = value.id
      anchoredUserID = value.guide == true ? nil : value.id + ":user"
      followsBottom = true
      trackingPausedByGesture = false
      replyHaptics.arm()
    }
    applyRows()
  }

  func handoffDidSettle(_ id: String) {
    guard window != nil else { return }
    guard pendingSend?.id == id || handoffID == id || rows.values.contains(where: { $0.entryID == id }) else { return }
    applyRows()
  }

  func setInitialDraft(_ text: String) {
    guard !hasInitialDraft else { return }
    hasInitialDraft = true
    composer.setInitialDraft(text)
    awaitingUserAnchor = !text.isEmpty
  }
  func setInitialAttachments(_ json: String) { composer.setInitialAttachments(json) }
  func clearDraft(token: Int) {
    guard token > lastAcknowledgedDraftToken else { return }
    lastAcknowledgedDraftToken = token
    composerHasAcknowledgedSend = true
    composer.clearDraft(token: token)
    applyRows()
  }
  func restoreDraft(token: Int) {
    guard token > lastRestoredDraftToken else { return }
    lastRestoredDraftToken = token
    if let pendingSend {
      ChatSendHandoff.cancel(id: pendingSend.id)
      turnStartedAt[pendingSend.id] = nil
      self.pendingSend = nil
      applyRows()
    }
    composer.restoreDraft(token: token)
  }
  func setComposerState(_ json: String) {
    composer.setComposerState(json)
    let retired = composer.suppressesComposer
    if retired != composerRetired {
      composerRetired = retired
      retireComposer(retired)
    }
    applyOverlay()
  }

  func retireComposer(_ retired: Bool) {
    composer.isUserInteractionEnabled = !retired && processEntryID.isEmpty
    if retired { endEditing(true) }
    if processEntryID.isEmpty { composer.isHidden = false }
    let distance = max(composer.bounds.height + 16, 88)
    composerBottom.constant = retired ? distance : 0
    let changes = {
      self.composer.alpha = retired ? 0 : 1
      self.layoutIfNeeded()
    }
    let finish: (Bool) -> Void = { finished in
      guard finished, self.composerRetired == retired else { return }
      self.composer.isHidden = retired || !self.processEntryID.isEmpty
    }
    let duration = UIAccessibility.isReduceMotionEnabled ? 0.2 : 0.45
    UIView.animate(
      withDuration: duration,
      delay: 0,
      options: [.beginFromCurrentState, .allowUserInteraction, .curveEaseInOut],
      animations: changes,
      completion: finish
    )
  }

  func setRelayContentHidden(_ hidden: Bool) {
    // Window-hosted glass must not sample the destination before adoption.
    collection.alpha = hidden ? 0 : 1
    overlay.alpha = hidden ? 0 : 1
    composer.isHidden = hidden || composerRetired || !processEntryID.isEmpty
  }

  func adoptComposerIfNeeded() {
    guard let pendingSend,
          let source = LodyComposerView.relays[pendingSend.id],
          let payload = source.relayPayload else { return }
    // The source remains visible above navigation until this page can adopt it.
    setRelayContentHidden(true)
    guard hasAppeared, let window, bounds.width > 0, bounds.height > 0 else { return }
    source.prepareDestination(self)
    guard source.window == nil else { return }
    let old = composer
    let acknowledged = composerHasAcknowledgedSend
    let incoming = source.composer
    let frame = incoming.convert(incoming.bounds, to: window)
    let inputBefore = incoming.relayInputState
    let destinationContentHidden = collection.alpha == 0 && overlay.alpha == 0
    let links = constraints.filter { ($0.firstItem as? UIView) === old || ($0.secondItem as? UIView) === old }
    let replacements = links.map { link in
      let replacement = NSLayoutConstraint(
        item: (link.firstItem as? UIView) === old ? incoming : link.firstItem!,
        attribute: link.firstAttribute, relatedBy: link.relation,
        toItem: (link.secondItem as? UIView) === old ? incoming : link.secondItem,
        attribute: link.secondAttribute, multiplier: link.multiplier, constant: link.constant
      )
      replacement.priority = link.priority
      return replacement
    }
    incoming.onSend = old.onSend
    incoming.onStop = old.onStop
    incoming.onSteer = old.onSteer
    incoming.onReconnect = old.onReconnect
    incoming.onPreview = old.onPreview
    incoming.onMentionBrowse = old.onMentionBrowse
    incoming.onComposerOptionChange = old.onComposerOptionChange
    incoming.onDraftChange = old.onDraftChange
    incoming.allowsFullScreen = old.allowsFullScreen
    incoming.fullScreenTopInset = old.fullScreenTopInset
    // The conversation's run config, not the creation page's, answers the chip from here on.
    incoming.onRunConfig = old.onRunConfig
    incoming.cardStyle = old.cardStyle
    incoming.restsCollapsed = old.restsCollapsed
    incoming.setInputIdentifier("session-input")
    NSLayoutConstraint.deactivate(links)
    old.removeFromSuperview()
    composer = incoming
    source.completeRelay()
    UIView.performWithoutAnimation {
      addSubview(incoming)
      incoming.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate(replacements)
      bringSubviewToFront(overlay)
      layoutIfNeeded()
    }
    if LodyUIVerify.enabled {
      let adopted = incoming.convert(incoming.bounds, to: window)
      let report: [String: Any] = [
        "sameComposer": composer === source.composer,
        "placeholderHidden": old.isHidden,
        "destinationContentHidden": destinationContentHidden,
        "destinationContentRestored": collection.alpha == 1 && overlay.alpha == 1,
        "inputBefore": inputBefore, "inputAfter": incoming.relayInputState,
        "source": [frame.minX, frame.minY, frame.width, frame.height],
        "adopted": [adopted.minX, adopted.minY, adopted.width, adopted.height],
      ]
      if let data = try? JSONSerialization.data(withJSONObject: report) {
        try? data.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("lody-production-composer-relay.json"))
      }
    }
    incoming.commitSend(payload)
    incoming.adoptConfiguration(from: old)
    incoming.setPendingSend(pendingSend)
    self.pendingSend = nil
    setPendingSend(pendingSend)
    if acknowledged {
      incoming.clearPendingSend(id: pendingSend.id)
      composerHasAcknowledgedSend = true
      applyRows()
    }
  }
  func setComposerOptions(_ json: String) { composer.setComposerOptions(json) }
  var tabClosed = false
  func setTabClosed(_ closed: Bool) {
    if tabClosed != closed { empty.isHidden = !closed }
    tabClosed = closed
    composer.isHidden = closed || composerRetired || !processEntryID.isEmpty
    composer.isUserInteractionEnabled = !closed && !composerRetired
    if closed { endEditing(true) }
  }

  func setEmptyText(_ text: String) { empty.text = text }
}
