import UIKit

extension LodyChatView {
  func setPlanDecisionState(_ json: String) {
    let next = try? JSONDecoder().decode(ChatPlanDecisionState.self, from: Data(json.utf8))
    guard next != planDecisionState else { return }
    planDecisionState = next
    applyRows()
  }

  func setErrorRetryState(_ json: String) {
    let next = try? JSONDecoder().decode(ChatErrorRetryState.self, from: Data(json.utf8))
    guard next != errorRetryState else { return }
    errorRetryState = next
    applyRows()
  }

  func setProcessStartID(_ id: String) {
    guard processStartID != id else { return }
    processStartID = id
    deferredRows.removeAll()
    applyRows()
  }

  func setProcessEntryID(_ id: String) {
    guard processEntryID != id else { return }
    processEntryID = id
    deferredRows.removeAll()
    backgroundColor = processBackground
    composer.isHidden = !id.isEmpty || composerRetired
    edgeFade.isHidden = !id.isEmpty
    setNeedsLayout()
    applyRows()
  }

  func setEntries(_ json: String, animate: Bool = true) {
    if historyLoadStarted == 0 { historyLoadStarted = CACurrentMediaTime() }
    pendingEntries = (json, animate && (pendingEntries?.animate ?? true))
  }

  func scheduleUpdate() {
    // All props have arrived. Cached first content is already decoded before push.
    guard !decoding, let input = pendingEntries else { return }
    let json = input.json
    pendingEntries = nil
    if let prepared = preparedEntries {
      preparedEntries = nil
      if prepared.json == json {
        receiveEntries(prepared.entries, animate: false)
        return
      }
      // Live props can overtake mounting. Keep the prepared first frame while
      // decoding that newer snapshot, just as an already-visible chat would.
      if !hasPositionedContent { receiveEntries(prepared.entries, animate: false) }
    }
    decoding = true
    preparation.async { [weak self] in
      let decoded = Result { try PreparedChatEntries.decode(json) }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.decoding = false
        switch decoded {
        case .success(let entries): self.receiveEntries(entries, animate: input.animate)
        case .failure: self.displayError = String(localized: "native.chat.error.transcript", bundle: .lody)
        }
        self.scheduleUpdate()
      }
    }
  }

  private func receiveEntries(_ received: [ChatEntry], animate: Bool) {
    if !animate { pendingSnapshotEntries.formUnion(received.map(\.id)) }
    // Web shows reasoning only for builtin DSH; other providers' thoughts and `think` steps
    // never reach the transcript.
    let entries = showsThoughts ? received : received.map { entry in
      var entry = entry
      entry.items.removeAll { $0.type == "thought" || ($0.type == "tool_call" && $0.kind == "think") }
      return entry
    }
    if let page = messageDetailsPage { page.update(entries.first { $0.id == page.entryId }) }
    streamPerformanceProbe?.receive(entries)
    displayError = nil
    let user = entries.last { $0.role == "user" && !$0.isQueued }
    let userID = user?.id
    if processEntryID.isEmpty, userID != lastUserID, user?.delivery != nil {
      anchoredUserID = nil
      awaitingUserAnchor = false
    }
    if processEntryID.isEmpty, let userID, userID != lastUserID, awaitingUserAnchor {
      liveEntryID = nil
      anchoredUserID = userID + ":user"
      awaitingUserAnchor = false
      trackingPausedByGesture = false
      followsBottom = true
    }
    lastUserID = userID
    stream.receive(entries, animate: animate && window != nil && !UIAccessibility.isReduceMotionEnabled, deferredEntries: Set(deferredRows.keys), initialSnapshot: !hasPositionedContent)
    if hasPositionedContent { startFrameTimer() }
    else { renderFrame() }
  }

  func startFrameTimer() {
    guard frameTimer == nil else { return }
    guard !rendering else { framePending = true; return }
    guard window != nil else { stream.finish(); return }
    let interval = ChatStream.commitInterval(tailLength: renderTailLength)
    let delay = max(0.001, lastRenderTime + interval - CACurrentMediaTime())
    let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.frameTimer = nil
        if UIAccessibility.isReduceMotionEnabled { self.stream.finish() }
        self.renderFrame()
      }
    }
    frameTimer = timer
    RunLoop.main.add(timer, forMode: .common)
  }

  func renderFrame() {
    guard !rendering else { framePending = true; return }
    updateDeferredStreams()
    rendering = true
    lastRenderTime = CACurrentMediaTime()
    let animating = Set(rows.values.filter { store.isAnimating(id: $0.id) }.map(\.entryID))
    stream.advance(animatingEntries: animating)
    let entries = stream.presentation
    let snapshots = pendingSnapshotEntries
    pendingSnapshotEntries.removeAll()
    if !hasPositionedContent {
      // The first snapshot belongs to this layout transaction, not a later timer.
      transcript.entries = entries
      snapshotEntries.formUnion(snapshots)
      applyRows()
      rendering = false
      // The first layout may receive another snapshot while its diff is committing.
      // Do not strand pending reveals until the next network update.
      if framePending || stream.hasPending {
        framePending = false
        startFrameTimer()
      }
      return
    }
    let parser = store.parser
    let deferred = Set(deferredRows.keys)
    let prepareIDs = Set(entries.suffix(2).map(\.id)).union(catchingUpEntries)
    preparation.async { [weak self] in
      for entry in entries where prepareIDs.contains(entry.id) && !deferred.contains(entry.id) {
        for item in entry.items where item.type == "text" || item.type == "thought" {
          _ = parser.parse(item.text ?? "", streaming: entry.isRunning && item.itemId == entry.textTailID)
        }
      }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.transcript.entries = entries
        self.snapshotEntries.formUnion(snapshots)
        self.applyRows()
        self.rendering = false
        self.updateDeferredStreams()
        if self.framePending || self.stream.hasPending {
          self.framePending = false
          self.startFrameTimer()
        }
      }
    }
  }

  func text(for row: ChatRow) -> NSAttributedString {
    let scale = UIFont.dynamicScale(compatibleWith: traitCollection)
    let paragraph = NSMutableParagraphStyle()
    if row.kind == "delivery" { paragraph.alignment = .right }
    let lineHeight = (row.kind == "user" ? 25 : 18) * scale
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    let font = ChatCell.messageFont(for: row, compatibleWith: traitCollection)
    if row.kind == "tool_call" { paragraph.lineBreakMode = .byTruncatingTail }
    let displayText = row.kind == "tool_call"
      ? row.text.components(separatedBy: .newlines).joined(separator: " ") : row.text
    let text = NSAttributedString(string: displayText, attributes: [
      .font: font,
      .foregroundColor: textColor(for: row),
      .paragraphStyle: paragraph,
      .baselineOffset: (lineHeight - font.lineHeight) / 2,
    ])
    if row.kind == "user" { return ChatUserMentions.decorate(text, references: row.references, repository: mentionRepository, traits: traitCollection) }
    return text
  }

  func applyOverlay() {
    if !processEntryID.isEmpty {
      overlay.slot = .idle
      return
    }
    overlay.slot = ChatOverlay.slot(connection: composer.connection)
  }

  func applyRows() {
    if let pendingSend, LodyComposerView.relays[pendingSend.id] != nil { return }
    applyOverlay()
    guard !applying else { needsApply = true; return }
    catchingUpEntries.formUnion(snapshotEntries)
    snapshotEntries.removeAll()
    applying = true
    let commitStart = CACurrentMediaTime()
    let previousOffset = collection.contentOffset.y
    let previousHistoryStart = historyStartID
    if composerHasAcknowledgedSend, let pendingSend,
       transcript.entries.contains(where: { $0.id == pendingSend.id }),
       pendingSend.rows(entries: transcript.entries).isEmpty {
      self.pendingSend = nil
    }
    var queue = transcript.entries.filter(\.isQueued).map { entry in
      ChatQueuedDraft(
        id: entry.id,
        text: entry.items.compactMap { $0.type == "text" ? $0.text : nil }.joined(separator: "\n"),
        canSteer: entry.canSteer != false,
        attachments: entry.items.compactMap { $0.image?.fileName ?? $0.file?.fileName }
      )
    }
    if let pendingSend, pendingSend.queue == true, pendingSend.failed != true,
       !transcript.entries.contains(where: { $0.id == pendingSend.id }) {
      queue.append(ChatQueuedDraft(
        id: pendingSend.id,
        text: pendingSend.displayText ?? pendingSend.text,
        canSteer: false,
        attachments: pendingSend.attachments.map(\.name)
      ))
    }
    composer.setQueue(queue)
    let now = Date().timeIntervalSince1970 * 1000
    transcript.expandedWork = expandedWork
    transcript.expandedThoughts = expandedThoughts
    var projected = transcript.rows(
      processEntryID: processEntryID,
      processStartID: processStartID,
      now: now,
      turnStartedAt: turnStartedAt
    )
    deferredRows = deferredRows.filter { id, _ in transcript.entries.contains { $0.id == id } }
    if !deferredRows.isEmpty {
      let byEntry = Dictionary(grouping: projected, by: \.entryID)
      var deferredInserted = Set<String>()
      projected = projected.flatMap { row -> [ChatRow] in
        guard let frozen = deferredRows[row.entryID] else { return [row] }
        guard deferredInserted.insert(row.entryID).inserted else { return [] }
        return ChatStream.deferringMarkdown(byEntry[row.entryID] ?? [], previous: frozen)
      }
    }
    projected = ChatOperationPresentation.visible(projected, expanded: expandedOperations, titles: operationTitles)
    for index in projected.indices {
      guard let card = projected[index].operation else { continue }
      projected[index].operationCurrent = card.sessionId == operationCurrentID
      projected[index].operationAgentType = operationAgentTypes[card.sessionId]
      projected[index].operationCLIType = operationCLITypes[card.sessionId]

    }
    projected = ChatOperationGrouping.rows(projected, roots: operationRoots, opened: operationOpened)
    for index in projected.indices where projected[index].kind == "proposed_plan" {
      if let state = planDecisionState, state.entryId == projected[index].entryID, state.itemId == projected[index].itemID {
        projected[index].planDecision = state
      }
    }
    for index in projected.indices where projected[index].kind == "chat_failed" {
      if let state = errorRetryState, state.entryId == projected[index].entryID, state.itemId == projected[index].itemID {
        projected[index].errorRetry = state
      }
    }
    if processEntryID.isEmpty, let pendingSend {
      for row in pendingSend.rows(entries: transcript.entries) {
        if row.kind == "delivery", let index = projected.firstIndex(where: { $0.entryID == row.entryID }) {
          projected.insert(row, at: index)
        } else {
          projected.append(row)
        }
      }
    }
    for index in projected.indices where projected[index].kind == "attachments" {
      let entry = projected[index].entryID
      if projected[index].attachments.contains(where: { $0.localURI != nil }) {
        localAttachments[entry] = projected[index].attachments
      } else if let local = localAttachments[entry], local.count == projected[index].attachments.count {
        for item in projected[index].attachments.indices {
          let remote = projected[index].attachments[item]
          let convertedImage = local[item].image != nil && remote.image != nil
            && (local[item].fileName as NSString).deletingPathExtension == (remote.fileName as NSString).deletingPathExtension
          guard local[item].fileName == remote.fileName || convertedImage else { continue }
          projected[index].attachments[item].localURI = local[item].localURI
          projected[index].attachments[item].localID = local[item].id
        }
      }
    }
    localAttachments = localAttachments.filter { key, _ in projected.contains { $0.entryID == key } }
    projected = ChatPendingSend.hidingStatus(
      projected,
      inFlight: Set(projected.map(\.entryID).filter { ChatSendHandoff.isInFlight(id: $0) })
    )
    // Keep a confirmed status in the layout while its height and opacity shrink.
    // Remove it only after the adjacent bubble has reached its final position.
    let activeIDs = Set(projected.map(\.id))
    for id in deliveryExits.keys where activeIDs.contains(id) {
      deliveryExits[id] = nil
      rowHeights[id] = nil
    }
    if hasPositionedContent && window != nil && !UIAccessibility.isReduceMotionEnabled {
      for row in rows.values where row.kind == "delivery" && !activeIDs.contains(row.id) {
        guard let index = projected.firstIndex(where: { $0.entryID == row.entryID }) else { continue }
        if deliveryExits[row.id] == nil {
          let width = ChatReadingColumn.itemWidth(in: collection.bounds.width)
          let height = rowHeight(row, width: width)
          deliveryExits[row.id] = height
          rowHeights[row.id] = (height, 0, width)
        }
        if rowHeights[row.id] != nil { projected.insert(row, at: index) }
      }
    }
    deliveryExits = deliveryExits.filter { id, _ in projected.contains { $0.id == id } }
    let signedInUser = AuthSession.shared.snapshot.account?.user
    for index in projected.indices where !projected[index].author.isEmpty {
      let author = projected[index].author
      let memberID = author == ChatAuthors.unknownSender ? signedInUser?.id : author
      if let memberID, let member = members[memberID] {
        projected[index].authorName = member.name
        projected[index].authorImage = member.image ?? ""
      } else if let user = signedInUser, author == ChatAuthors.unknownSender || author == user.id {
        projected[index].authorName = user.name
        projected[index].authorImage = user.image ?? ""
      }
    }
    updateWorkDurationTimer(rows: projected)
    let entryIDsToRetain = Set(projected.map(\.entryID))
    expandedMessages.formIntersection(entryIDsToRetain)
    expandedAttachments.formIntersection(entryIDsToRetain)
    if tabClosed { projected = [] }
    let retainedIDs = Set(projected.map(\.id))
    expandedPlans.formIntersection(retainedIDs)
    projected = prepareHistory(projected)
    let insertingHistory = previousHistoryStart != nil && previousHistoryStart != historyStartID
    // Starting/waiting for a page changes only the header, not the collection.
    if preparingHistory, projected.count == rows.count,
       projected.allSatisfy({ rows[$0.id] == $0 }) {
      applying = false
      updateHistoryHeader()
      return
    }
    let liveEntryID = transcript.entries.last { $0.isRunning && (processEntryID.isEmpty || $0.id == processEntryID) }?.id
    let previousLive = self.liveEntryID
    let starting = previousLive == nil && liveEntryID != nil
    let nearTail = collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom - previousOffset < CGFloat(ChatScroll.resumeDistance)
    let following = followsBottom || (starting && nearTail && !trackingPausedByGesture)
    followsBottom = following
    // Guidance joins the current reply without reserving a new turn's viewport.
    let delivered = projected.last {
      $0.kind == "user" && $0.entryID != handoffID && ChatSendHandoff.isWaiting(id: $0.entryID)
    }
    if let delivered {
      let guiding = transcript.entries.contains { $0.id == delivered.entryID && $0.delivery != nil }
      if guiding { anchoredUserID = nil }
      else if following { anchoredUserID = delivered.id }
    }
    let completing = previousLive != nil && liveEntryID == nil
    // A stale running reply can complete together with an entire newer history.
    // Only fold in place when it is still the tail; bulk sync keeps the viewport anchor.
    let folding = completing && deferredRows[previousLive ?? ""] == nil && processEntryID.isEmpty && window != nil && projected.last?.entryID == previousLive
    let toggled = toggleAnchor.flatMap { id in projected.contains { $0.id == id } ? id : nil }
    toggleAnchor = nil
    let anchorID = toggled ?? (folding && following
      ? projected.last(where: { $0.entryID == previousLive && $0.kind == "text" })?.id
      : collection.indexPathsForVisibleItems.sorted().compactMap { dataSource.itemIdentifier(for: $0) }.first(where: { id in projected.contains { $0.id == id } }))
    let anchor = anchorID.flatMap { id -> (String, CGFloat)? in
      guard let index = dataSource.indexPath(for: id), let frame = collection.layoutAttributesForItem(at: index)?.frame else { return nil }
      return (id, frame.minY - previousOffset)
    }
    guard Set(projected.map(\.id)).count == projected.count else {
      applying = false
      displayError = String(localized: "native.chat.error.transcript", bundle: .lody)
      return
    }
    if ChatHaptics.shouldNotifyTurnCompletion(
      previousLive: previousLive,
      nextLive: liveEntryID,
      processEntryID: processEntryID,
      inWindow: window != nil
    ) {
      turnFeedback.notificationOccurred(.success)
    }
    if liveEntryID != nil && processEntryID.isEmpty && window != nil && previousLive != liveEntryID {
      turnFeedback.prepare()
    }
    if replyHaptics.armed, let liveEntryID, processEntryID.isEmpty, window != nil, !catchingUpEntries.contains(liveEntryID) {
      let length = projected.reduce(0) { $1.entryID == liveEntryID && $1.kind == "text" ? $0 + $1.text.utf8.count : $0 }
      let before = replyText?.entryID == liveEntryID ? replyText?.length ?? 0 : 0
      if length > before { replyHaptics.textGrew() }
      replyText = (liveEntryID, length)
    } else {
      replyText = nil
    }
    self.liveEntryID = liveEntryID
    let previous = rows
    if !deferredRows.isEmpty, dataSource.snapshot().itemIdentifiers == projected.map(\.id),
       projected.allSatisfy({ previous[$0.id] == $0 }) {
      applying = false
      updateBottomButton()
      return
    }
    store.nonAnimatedRows = Set(projected.filter { catchingUpEntries.contains($0.entryID) }.map(\.id))
    prepareRowHeights(projected, previous: previous, animate: !folding && delivered == nil)
    for (id, height) in deliveryExits where rowHeights[id] == nil {
      rowHeights[id] = (height, 0, ChatReadingColumn.itemWidth(in: collection.bounds.width))
    }
    rows = Dictionary(projected.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    let settlingDelivery = hasPositionedContent && window != nil && !insertingHistory && catchingUpEntries.isEmpty
      && previous.values.contains { row in row.kind == "delivery" && rows[row.id] == nil && entryIDsToRetain.contains(row.entryID) }
    measurements = measurements.filter { retainedIDs.contains($0.key) }
    store.retain(retainedIDs)
    var snapshot = NSDiffableDataSourceSnapshot<String, String>()
    let grouped = Dictionary(grouping: projected, by: \.entryID)
    var seenEntryIDs = Set<String>()
    var entryIDs = projected.map(\.entryID).filter { seenEntryIDs.insert($0).inserted }
    if let pendingSend, !entryIDs.contains(pendingSend.id) { entryIDs.append(pendingSend.id) }
    for id in entryIDs {
      guard let entryRows = grouped[id], !entryRows.isEmpty else { continue }
      if let duration = entryRows.firstIndex(where: { $0.kind == "duration" }) {
        // The local timer already occupies the reply section. Server takeover
        // replaces its contents without moving the timer across section insets.
        if duration > 0 {
          snapshot.appendSections([id])
          snapshot.appendItems(entryRows[..<duration].map(\.id), toSection: id)
        }
        let replySection = entryRows[duration].id
        snapshot.appendSections([replySection])
        snapshot.appendItems(entryRows[duration...].map(\.id), toSection: replySection)
      } else {
        snapshot.appendSections([id])
        snapshot.appendItems(entryRows.map(\.id), toSection: id)
      }
    }
    snapshot.reconfigureItems(projected.filter { previous[$0.id] != nil && previous[$0.id] != $0 }.map(\.id))
    empty.isHidden = !tabClosed && !projected.isEmpty
    let updateLayout = { [self] in
      // Queue/attachment removal changes the composer's intrinsic height and
      // therefore the scroll inset used to calculate the flight destination.
      self.layoutIfNeeded()
      self.collection.collectionViewLayout.invalidateLayout()
      self.collection.layoutIfNeeded()
      self.updateBottomInset()
      if !folding || !self.followsBottom { self.restoreAnchor(anchor) }
      if !self.followsBottom, let (id, offset) = anchor, let index = self.dataSource.indexPath(for: id), let frame = self.collection.layoutAttributesForItem(at: index)?.frame {
        self.historyAnchorError = max(self.historyAnchorError, abs(frame.minY - self.collection.contentOffset.y - offset))
      }
      if self.followsBottom { self.scrollToBottom() }
      if !projected.isEmpty { self.hasPositionedContent = true }
      if !self.rowHeights.isEmpty { self.startMotion() }
      self.updateBottomButton()
      self.deliverPendingContent()
    }
    let finish = { [weak self] in
      // UIKit may invoke snapshot completion before its apply call returns.
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        if folding { ChatContextViewProbe.checkHitTesting() }
        self.recordHistoryCommit()
        self.streamPerformanceProbe?.commit(milliseconds: (CACurrentMediaTime() - commitStart) * 1000)
        self.applying = false
        self.scrollToEditedMessage()
        self.catchingUpEntries.removeAll()
        self.store.nonAnimatedRows.removeAll()
        self.updateDeferredStreams()
        self.refreshFind()
        self.updateHistoryHeader()
        self.prefetchHistoryIfNeeded()
        self.deliverPendingContent()
        if let tail = projected.last(where: { $0.streaming }) {
          self.renderTailLength = self.store.tailLength(id: tail.id)
        }
        if self.needsApply || self.needsTextRefresh {
          self.drainChatUpdates()
        } else {
          self.imagePreview?.updateItems(ChatImageGallery.items(from: projected))
        }
      }
    }
    if folding && !UIAccessibility.isReduceMotionEnabled {
      UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseInOut]) {
        self.dataSource.apply(snapshot, animatingDifferences: true, completion: finish)
        updateLayout()
      }
    } else if folding || (settlingDelivery && UIAccessibility.isReduceMotionEnabled) {
      UIView.transition(with: collection, duration: 0.12, options: [.transitionCrossDissolve]) {
        self.dataSource.apply(snapshot, animatingDifferences: false)
        updateLayout()
      } completion: { _ in finish() }
    } else if insertingHistory || !catchingUpEntries.isEmpty {
      // Resolve the viewport inside UIKit's update, before the first new frame.
      historyLayoutAnchor = anchor
      UIView.performWithoutAnimation {
        dataSource.apply(snapshot, animatingDifferences: true) {
          updateLayout()
          self.historyLayoutAnchor = nil
          finish()
        }
      }
    } else {
      dataSource.apply(snapshot, animatingDifferences: false) {
        updateLayout()
        finish()
      }
    }
  }

  private func updateWorkDurationTimer(rows: [ChatRow]) {
    let needsTimer = window != nil && ChatWorkDuration.needsTimer(rows)
    guard needsTimer else {
      workDurationTimer?.invalidate()
      workDurationTimer = nil
      return
    }
    guard workDurationTimer == nil else { return }
    let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.applyRows() }
    }
    workDurationTimer = timer
    RunLoop.main.add(timer, forMode: .common)
  }
}

private func textColor(for row: ChatRow) -> UIColor {
  if row.kind == "chat_failed" { return .systemRed }
  // No warning orange in a conversation (failed steps look like any other).
  if row.kind == "changes" || row.kind == "file" || (row.kind == "summary" && row.running) { return .lodyAccent }
  if row.kind == "user" { return .label }
  return .secondaryLabel
}

extension LodyChatView {
  /// Keep the displayed boundary by entry ID so live appends do not evict history.
  /// Only the next page is measured; UIKit text measurement stays on main.
  func prepareHistory(_ projected: [ChatRow]) -> [ChatRow] {
    historyPreparation?.cancel()
    historyPreparation = nil
    let entryIDs = projected.reduce(into: [String]()) { ids, row in
      if ids.last != row.entryID { ids.append(row.entryID) }
    }
    historyFirstID = entryIDs.first
    guard !entryIDs.isEmpty else {
      historyStartID = nil
      historyTargetID = nil
      preparingHistory = false
      hasEarlierHistory = remoteHasEarlierHistory
      hasPagedHistory = remoteHasEarlierHistory
      return projected
    }
    let retainedStart = historyStartID.flatMap { entryIDs.firstIndex(of: $0) }
    let start = retainedStart ?? max(0, entryIDs.count - 50)
    historyStartID = entryIDs[start]
    hasEarlierHistory = start > 0 || remoteHasEarlierHistory
    hasPagedHistory = hasEarlierHistory || (retainedStart != nil && hasPagedHistory)
    let width = ChatReadingColumn.itemWidth(in: collection.bounds.width)
    if width != historyWidth {
      preparedHistory.removeAll()
      historyWidth = width
    }
    if preparingHistory {
      let target = min(start, historyTargetID.flatMap { entryIDs.firstIndex(of: $0) } ?? max(0, start - 50))
      historyTargetID = entryIDs[target]
      let page = Set(entryIDs[target..<start])
      let remaining = projected.filter { page.contains($0.entryID) && preparedHistory[$0.id] != $0 }
      if remaining.isEmpty && !historyScrollIsMoving {
        historyStartID = historyTargetID
        historyTargetID = nil
        preparingHistory = false
        preparedHistory.removeAll()
        hasEarlierHistory = target > 0 || remoteHasEarlierHistory
      } else if !remaining.isEmpty, window != nil {
        prepareHistorySlice(remaining, index: 0, width: width)
      }
    }
    let boundary = projected.firstIndex { $0.entryID == historyStartID } ?? 0
    return Array(projected[boundary...])
  }

  var historyScrollIsMoving: Bool {
    collection.isTracking || collection.isDecelerating || scrollingToTop
  }

  func commitPreparedHistory() {
    if preparingHistory { applyRows() }
  }

  func loadEarlierHistory() {
    guard hasEarlierHistory, !preparingHistory, !applying, window != nil else { return }
    if historyStartID == historyFirstID, remoteHasEarlierHistory {
      guard !remoteHistoryLoading else { return }
      onLoadEarlierHistory()
      return
    }
    pauseTracking()
    preparingHistory = true
    applyRows()
  }

  func prefetchHistoryIfNeeded() {
    guard !findPresented, !followsBottom, hasPositionedContent,
          collection.contentOffset.y + collection.adjustedContentInset.top < collection.bounds.height else { return }
    loadEarlierHistory()
  }

  func updateHistoryHeader() {
    for case let header as ChatHistoryHeader in collection.visibleSupplementaryViews(ofKind: UICollectionView.elementKindSectionHeader) {
      header.configure(loading: preparingHistory || remoteHistoryLoading, hasEarlier: hasEarlierHistory)
    }
  }

  private func prepareHistorySlice(_ rows: [ChatRow], index: Int, width: CGFloat) {
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.window != nil else { return }
      self.historyPreparation = nil
      guard ChatReadingColumn.itemWidth(in: self.collection.bounds.width) == width else {
        self.applyRows()
        return
      }
      let started = CACurrentMediaTime()
      let deadline = started + 0.004
      var next = index
      // ponytail: one row can exceed the budget; block-level measurement is the
      // next step if individual huge messages dominate, rather than history size.
      repeat {
        let row = rows[next]
        let previousKind = next > 0 ? rows[next - 1].kind : nil
        _ = self.rowHeight(row, width: width, previousKind: previousKind)
        self.preparedHistory[row.id] = row
        next += 1
      } while next < rows.count && CACurrentMediaTime() < deadline
      self.historySliceTimes.append((CACurrentMediaTime() - started) * 1000)
      if next == rows.count {
        if !self.historyScrollIsMoving { self.applyRows() }
      } else {
        self.prepareHistorySlice(rows, index: next, width: width)
      }
    }
    historyPreparation = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.008, execute: work)
  }

  func recordHistoryCommit() {
    guard transcript.entries.first?.id == "perf-0", historyLoadStarted > 0 else { return }
    let elapsed = (CACurrentMediaTime() - historyLoadStarted) * 1000
    if historyFirstContent == 0, !rows.isEmpty {
      historyFirstContent = elapsed
      historyFirstRows = rows.count
    }
    if !preparingHistory, historyPages.last?["rows"] as? Int != rows.count {
      historyPages.append(["rows": rows.count, "firstEntry": historyStartID ?? "", "elapsedMs": elapsed])
    }
    guard !preparingHistory, !hasEarlierHistory, rows.count == 15_000 else { return }
    let report: [String: Any] = [
      "firstContentMs": historyFirstContent, "firstRows": historyFirstRows,
      "completeMs": elapsed, "rows": rows.count,
      "sliceMs": historySliceTimes, "pages": historyPages, "anchorError": historyAnchorError,
      "metric": "Native entries prop to layout completion; excludes JS fixture creation",
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: .sortedKeys) {
      try? data.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("lody-chat-loading.json"), options: .atomic)
    }
    historyLoadStarted = 0
  }
}
