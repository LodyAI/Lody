import UIKit

extension LodyChatView {
  var composerInset: CGFloat {
    // Retiring glass keeps its drawing space, not the transcript's scroll space.
    processEntryID.isEmpty ? max(0, bounds.maxY - composer.frame.minY - composer.retiringQueueHeight - collection.safeAreaInsets.bottom) + 8 : 0
  }

  @discardableResult
  func updateBottomInset() -> Bool {
    let base = composerInset
    var space: CGFloat = 0
    if let id = anchoredUserID,
       let entryID = rows[id]?.entryID,
       let index = dataSource.indexPath(for: entryID + ":delivery") ?? dataSource.indexPath(for: id),
       let frame = collection.layoutAttributesForItem(at: index)?.frame {
      let naturalBottom = collection.contentSize.height - collection.bounds.height + collection.safeAreaInsets.bottom + base
      space = max(0, frame.minY - collection.adjustedContentInset.top - naturalBottom)
    }
    let bottom = base + space
    // Compensate even one pixel of reply growth: at 3x, a 0.5pt deadband
    // lets the bottom follower move the pinned turn by 1px and back again.
    guard collection.contentInset.bottom != bottom else { return false }
    let offset = collection.contentOffset
    collection.contentInset.bottom = bottom
    if !followsBottom { collection.contentOffset = offset }
    collection.verticalScrollIndicatorInsets.bottom = base
    return true
  }

  func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id] else { return false }
    if let cell = collectionView.cellForItem(at: indexPath) as? ChatCell, cell.expandable && !cell.expanded { return true }
    return row.actionable || row.image != nil
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    if let cell = collectionView.cellForItem(at: indexPath) as? ChatCell,
       cell.expandable, !cell.expanded, let row = cell.row {
      toggleExpansion(row)
      return
    }
    if let cell = collectionView.cellForItem(at: indexPath) as? ChatImageCell,
       let id = dataSource.itemIdentifier(for: indexPath) {
      openImageGallery(id: id, source: cell)
      return
    }
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id], row.actionable else { return }
    if row.kind == "duration", row.processStartID == "__work__" {
      // Open or close the turn's folded work in place; the row stays put while rows animate below.
      if !expandedWork.insert(row.entryID).inserted { expandedWork.remove(row.entryID) }
      UISelectionFeedbackGenerator().selectionChanged()
      toggleAnchor = row.id
      // Opening work is reading, not following the tail.
      followsBottom = false
      applyRows()
      return
    }
    if row.kind == "summary", row.processStartID.hasPrefix("__thought__:") {
      let key = String(row.processStartID.dropFirst("__thought__:".count))
      if !expandedThoughts.insert(key).inserted { expandedThoughts.remove(key) }
      UISelectionFeedbackGenerator().selectionChanged()
      toggleAnchor = row.id
      followsBottom = false
      applyRows()
      return
    }
    if row.kind == "changesHeader" {
      UISelectionFeedbackGenerator().selectionChanged()
      onActivityPress(["entryId": row.entryID, "itemId": "", "processStartId": "__turnFiles__"])
      return
    }
    if row.kind == "tasksHeader" {
      UISelectionFeedbackGenerator().selectionChanged()
      onActivityPress(["entryId": row.entryID, "itemId": "", "processStartId": "__taskSheet__"])
      return
    }
    if let file = row.file {
      openAttachment(file)
      return
    }
    if let pendingSend, id == pendingSend.id + ":pending", pendingSend.failed == true {
      onRetrySend([:])
      return
    }
    onActivityPress(["entryId": row.entryID, "itemId": row.itemID, "processStartId": row.processStartID])
  }

  func galleryItems() -> [ChatImagePreviewItem] {
    ChatImageGallery.items(from: dataSource.snapshot().itemIdentifiers.compactMap { rows[$0] })
  }

  func imageCell(id: String) -> ChatImageCell? {
    if let index = dataSource.indexPath(for: id),
       let cell = collection.cellForItem(at: index) as? ChatImageCell {
      return cell
    }
    guard let row = rows.values.first(where: {
      $0.kind == "attachments" && id.hasPrefix($0.entryID + ":attachment:")
    }), let index = dataSource.indexPath(for: row.id),
      let cell = collection.cellForItem(at: index) as? ChatMessageAttachmentsCell else { return nil }
    return cell.imageCell(id: id)
  }

  func openImageGallery(id: String, source: ChatImageCell?) {
    guard let controller = presenter(), controller.presentedViewController == nil else { return }
    let items = galleryItems()
    guard let index = ChatImageGallery.index(of: id, in: items) else { return }
    pauseTracking()
    var placeholders: [String: UIImage] = [:]
    for item in items {
      if let image = imageCell(id: item.id)?.displayedImage { placeholders[item.id] = image }
    }
    if let source, let image = source.displayedImage { placeholders[id] = image }
    imagePreview = ChatImagePreview.present(
      from: controller,
      items: items,
      index: index,
      workspace: imageWorkspace,
      session: imageSession,
      placeholders: placeholders,
      sourceView: { [weak self] pageId in
        guard let cell = self?.imageCell(id: pageId), cell.window != nil else { return nil }
        return cell.zoomSource
      }
    )
  }

  func openAttachment(_ attachment: ChatMessageAttachment) {
    guard let controller = presenter(), controller.presentedViewController == nil else { return }
    pauseTracking()
    if let uri = attachment.localURI, let url = URL(string: uri), url.isFileURL {
      controller.present(ChatAttachmentPreview([ChatAttachment(id: attachment.id, name: attachment.fileName, url: url, isImage: false)], index: 0), animated: true)
      return
    }
    controller.present(SessionFilePreview(file: attachment, workspace: imageWorkspace, session: imageSession), animated: true)
  }

  func toggleExpansion(_ row: ChatRow) {
    guard let index = dataSource.indexPath(for: row.id), let cell = collection.cellForItem(at: index) else { return }
    pauseTracking()
    ChatSendHandoff.cancel(id: row.entryID)
    if let cell = cell as? ChatPlanCell {
      if !expandedPlans.insert(row.id).inserted { expandedPlans.remove(row.id) }
      cell.expanded = expandedPlans.contains(row.id)
      rowHeights[row.id] = nil
    } else if let cell = cell as? ChatMessageAttachmentsCell {
      if !expandedAttachments.insert(row.entryID).inserted { expandedAttachments.remove(row.entryID) }
      cell.expanded = expandedAttachments.contains(row.entryID)
    } else if let cell = cell as? ChatCell {
      if !expandedMessages.insert(row.entryID).inserted { expandedMessages.remove(row.entryID) }
      cell.expanded = expandedMessages.contains(row.entryID)
    }
    let offset = collection.contentOffset
    let update = {
      self.collection.collectionViewLayout.invalidateLayout()
      self.collection.layoutIfNeeded()
      cell.setNeedsLayout()
      cell.layoutIfNeeded()
      self.updateBottomInset()
      self.collection.contentOffset.y = min(self.bottomOffset, max(-self.collection.adjustedContentInset.top, offset.y))
    }
    if UIAccessibility.isReduceMotionEnabled {
      update()
      UIAccessibility.post(notification: .layoutChanged, argument: nil)
    } else {
      UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState], animations: update) { _ in
        UIAccessibility.post(notification: .layoutChanged, argument: nil)
      }
    }
  }

  func deselectFileOnReturn(animated: Bool, coordinator: UIViewControllerTransitionCoordinator?) {
    guard let index = collection.indexPathsForSelectedItems?.first,
      let id = dataSource.itemIdentifier(for: index) else { return }
    guard let coordinator else {
      collection.deselectItem(at: index, animated: animated)
      return
    }
    let started = coordinator.animate(alongsideTransition: { [weak self] _ in
      guard let self, let current = self.dataSource.indexPath(for: id) else { return }
      self.collection.deselectItem(at: current, animated: animated)
    }, completion: { [weak self] context in
      guard context.isCancelled, let self, let current = self.dataSource.indexPath(for: id) else { return }
      self.collection.selectItem(at: current, animated: false, scrollPosition: [])
    })
    if !started { collection.deselectItem(at: index, animated: animated) }
  }

  func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
    guard scrollView === collection else { return true }
    scrollingToTop = true
    pauseTracking()
    return true
  }

  func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
    guard scrollView === collection else { return }
    scrollingToTop = false
    commitPreparedHistory()
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    guard scrollView === collection else { return }
    scrollingToTop = false
    pauseTracking()
  }

  func pauseTracking() {
    if let handoffID { ChatSendHandoff.cancelWaitingAttachments(id: handoffID) }
    followsBottom = false
    trackingPausedByGesture = true
    sendScroll = nil
    awaitingUserAnchor = false
  }

  /// Reuse measured geometry; scrolling must never parse or size unseen text.
  @discardableResult
  func updateDeferredStreams() -> Bool {
    guard hasPositionedContent, !applying, !rendering else { return false }
    let candidates = Set(rows.values.filter(\.streaming).map(\.entryID)).union(deferredRows.keys)
    let viewport = collection.bounds.inset(by: UIEdgeInsets(
      top: collection.adjustedContentInset.top, left: 0,
      bottom: collection.safeAreaInsets.bottom + composerInset, right: 0))
    var resumed = false
    for entryID in candidates {
      let entryRows = deferredRows[entryID] ?? rows.values.filter { $0.entryID == entryID }
      let textRows = entryRows.filter { $0.streaming && ($0.kind == "text" || $0.kind == "thought") }
      // Resume before the boundary reaches the screen, with hysteresis to avoid churn.
      let margin: CGFloat = deferredRows[entryID] == nil ? 80 : 160
      let nearby = viewport.insetBy(dx: 0, dy: -margin)
      let offscreen = !textRows.isEmpty && textRows.allSatisfy { row in
        guard let index = dataSource.indexPath(for: row.id),
              let frame = collection.layoutAttributesForItem(at: index)?.frame else { return false }
        let changing = store.tailFrame(id: row.id)?.offsetBy(dx: frame.minX, dy: frame.minY) ?? frame
        return !changing.intersects(nearby)
      }
      if !followsBottom, !findPresented, offscreen {
        if deferredRows[entryID] == nil {
          deferredRows[entryID] = dataSource.snapshot().itemIdentifiers.compactMap { rows[$0] }.filter { $0.entryID == entryID }
          stream.finish(entries: [entryID])
          for row in entryRows { rowHeights[row.id] = nil }
        }
      } else if deferredRows.removeValue(forKey: entryID) != nil {
        catchingUpEntries.insert(entryID)
        resumed = true
      }
    }
    if resumed { startFrameTimer() }
    return resumed
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    guard scrollView === collection else { return }
    updateDeferredStreams()
    updateBottomButton()
    refreshFindHighlights()
    prefetchHistoryIfNeeded()
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    guard scrollView === collection, !decelerate else { return }
    commitPreparedHistory()
    resumeTrackingAtBottom()
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    guard scrollView === collection else { return }
    commitPreparedHistory()
    resumeTrackingAtBottom()
  }

  func resumeTrackingAtBottom() {
    guard bottomOffset - collection.contentOffset.y <= 1 else { return }
    trackingPausedByGesture = false
    followsBottom = true
    scrollToBottom()
  }

  var bottomOffset: CGFloat {
    CGFloat(ChatScroll.bottom(contentHeight: Double(collection.contentSize.height),
      viewportHeight: Double(collection.bounds.height), topInset: Double(collection.adjustedContentInset.top),
      bottomInset: Double(collection.adjustedContentInset.bottom)))
  }

  func updateBottomButton() {
    let bottom = bottomOffset
    overlay.scrollVisible = processEntryID.isEmpty && !followsBottom && bottom - collection.contentOffset.y > CGFloat(ChatScroll.resumeDistance)
  }

  func scrollToBottom() {
    guard !movingLayout, !collection.isDragging, !collection.isDecelerating else { return }
    if !hasPositionedContent || UIAccessibility.isReduceMotionEnabled || window == nil {
      collection.setContentOffset(CGPoint(x: 0, y: bottomOffset), animated: false)
    } else if abs(collection.contentOffset.y - bottomOffset) > 0.5 {
      startMotion()
    }
  }

  func startMotion() {
    guard motionLink == nil, window != nil else { return }
    let link = CADisplayLink(target: ChatMotionTarget(self), selector: #selector(ChatMotionTarget.tick(_:)))
    motionTime = CACurrentMediaTime()
    motionLink = link
    link.add(to: .main, forMode: .common)
  }

  func advanceMotion(_ link: CADisplayLink) {
    guard !applying else { motionTime = link.targetTimestamp; return }
    let elapsed = min(1.0 / 30, max(0, link.targetTimestamp - motionTime))
    motionTime = link.targetTimestamp
    let reduce = UIAccessibility.isReduceMotionEnabled
    movingLayout = true
    if !rowHeights.isEmpty {
      let anchor = visibleAnchor()
      for (id, height) in rowHeights {
        let current = reduce ? height.target : CGFloat(ChatScroll.advance(
          Double(height.current), toward: Double(height.target), elapsed: elapsed, response: 0.06))
        rowHeights[id] = current == height.target ? nil : (current, height.target, height.width)
      }
      collection.collectionViewLayout.invalidateLayout()
      collection.layoutIfNeeded()
      updateBottomInset()
      restoreAnchor(anchor)
      for (id, originalHeight) in deliveryExits {
        if let index = dataSource.indexPath(for: id), let cell = collection.cellForItem(at: index) {
          let height = rowHeights[id]?.current ?? 0
          cell.contentView.alpha = max(0, height / max(1, originalHeight))
        }
      }
    }
    let tracking = followsBottom && !collection.isDragging && !collection.isDecelerating
    if tracking {
      let y: CGFloat
      if let sendScroll, !reduce {
        // Finish the list movement before the flying bubble lands.
        let progress = min(1, max(0, (link.targetTimestamp - sendScroll.started) / 0.25))
        let eased = CGFloat(1 - pow(1 - progress, 3))
        y = sendScroll.offset + (bottomOffset - sendScroll.offset) * eased
        if progress == 1 { self.sendScroll = nil }
      } else {
        y = reduce ? bottomOffset : CGFloat(ChatScroll.advance(
          Double(collection.contentOffset.y), toward: Double(bottomOffset), elapsed: elapsed, response: 0.10,
          minimumStep: 1 / Double(window?.screen.scale ?? 3)))
      }
      collection.setContentOffset(CGPoint(x: 0, y: y), animated: false)
    }
    deliverPendingContent()
    movingLayout = false
    if deliveryExits.keys.contains(where: { rowHeights[$0] == nil }) { applyRows() }
    updateBottomButton()
    if rowHeights.isEmpty && (!tracking || abs(collection.contentOffset.y - bottomOffset) <= 0.5) {
      link.invalidate()
      motionLink = nil
    }
  }

  func visibleAnchor() -> (String, CGFloat)? {
    for index in collection.indexPathsForVisibleItems.sorted() {
      if let id = dataSource.itemIdentifier(for: index), let frame = collection.layoutAttributesForItem(at: index)?.frame {
        return (id, frame.minY - collection.contentOffset.y)
      }
    }
    return nil
  }

  func restoreAnchor(_ anchor: (String, CGFloat)?) {
    // UIKit owns the top rubber band, including deceleration after release.
    // A live update must not clamp it to the resting boundary.
    guard collection.contentOffset.y >= -collection.adjustedContentInset.top else { return }
    guard let (id, y) = anchor, let index = dataSource.indexPath(for: id),
          let frame = collection.layoutAttributesForItem(at: index)?.frame else { return }
    collection.contentOffset.y = max(-collection.adjustedContentInset.top, frame.minY - y)
  }

  func prepareRowHeights(_ projected: [ChatRow], previous: [String: ChatRow], animate: Bool) {
    let ids = Set(projected.map(\.id))
    rowHeights = rowHeights.filter { ids.contains($0.key) }
    guard animate, hasPositionedContent, window != nil, !UIAccessibility.isReduceMotionEnabled else {
      rowHeights.removeAll()
      return
    }
    let width = ChatReadingColumn.itemWidth(in: collection.bounds.width)
    for row in projected where row != previous[row.id] {
      if catchingUpEntries.contains(row.entryID) { rowHeights[row.id] = nil; continue }
      // Long replies grow at the content-commit cadence. Animating their height
      // would invalidate the entire collection at display refresh rate; the
      // bottom follower and text fades already keep motion smooth.
      if (row.kind == "text" || row.kind == "thought") && row.text.utf16.count > 1024 {
        rowHeights[row.id] = nil
        continue
      }
      guard row.streaming || previous[row.id]?.streaming == true else {
        rowHeights[row.id] = nil
        continue
      }
      let oldFrame = dataSource.indexPath(for: row.id).flatMap { collection.layoutAttributesForItem(at: $0)?.frame }
      let current = rowHeights[row.id]?.current ?? oldFrame?.height ?? 12
      let target = rowHeight(row, width: width)
      if abs(current - target) > 0.5 { rowHeights[row.id] = (current, target, width) }
      else { rowHeights[row.id] = nil }
    }
  }

  func measure(_ row: ChatRow, width: CGFloat) -> CGFloat {
    if let image = row.image {
      let height = ChatImageCell.size(image, width: width).height
      return height
    }
    let textWidth = ChatCell.textWidth(row, width: width)
    if row.kind == "text" || row.kind == "thought" {
      return store.height(id: row.id, text: row.text, secondary: row.kind == "thought", streaming: row.streaming, width: textWidth)
    }
    let text = text(for: row)
    if let cached = measurements[row.id], cached.width == textWidth, cached.text.isEqual(to: text) {
      return cached.height
    }
    measuringText.setText(text)
    let height = measuringText.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude)).height
    if height > 0.5 {
      measurements[row.id] = (textWidth, text, height)
    }
    return height
  }

  func collectionView(_ collectionView: UICollectionView, targetContentOffsetForProposedContentOffset proposed: CGPoint) -> CGPoint {
    guard let (id, offset) = historyLayoutAnchor,
          let index = dataSource.indexPath(for: id),
          let frame = collectionView.layoutAttributesForItem(at: index)?.frame else { return proposed }
    return CGPoint(x: proposed.x, y: max(-collectionView.adjustedContentInset.top, frame.minY - offset))
  }

  func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, insetForSectionAt section: Int) -> UIEdgeInsets {
    let inset = ChatReadingColumn.horizontalInset(in: collectionView.bounds.width)
    return UIEdgeInsets(
      top: ChatReadingColumn.sectionTop,
      left: inset,
      bottom: ChatReadingColumn.sectionBottom,
      right: inset
    )
  }

  func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, referenceSizeForHeaderInSection section: Int) -> CGSize {
    CGSize(width: collectionView.bounds.width, height: section == 0 && processEntryID.isEmpty && hasPagedHistory ? 48 : 0)
  }

  func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    let width = ChatReadingColumn.itemWidth(in: collectionView.bounds.width)
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id] else { return CGSize(width: width, height: 0) }
    if let height = rowHeights[id], height.width == width {
      return CGSize(width: width, height: height.current)
    }
    rowHeights[id] = nil
    if deliveryExits[id] != nil { return CGSize(width: width, height: 0) }
    return CGSize(width: width, height: rowHeight(row, width: width))
  }

  func rowHeight(_ row: ChatRow, width: CGFloat, previousKind: String? = nil) -> CGFloat {
    if row.kind == "proposed_plan" {
      let body = store.height(id: row.id, text: row.text, secondary: false, streaming: row.streaming, width: max(1, width - 32))
      return ChatPlanCell.height(body: body, expanded: expandedPlans.contains(row.id), review: !row.planPermissionItemID.isEmpty, decision: row.planDecision)
    }
    if row.kind == "attachments" {
      return ChatMessageAttachmentsCell.height(count: row.attachments.count, width: width,
        expanded: expandedAttachments.contains(row.entryID), author: !row.author.isEmpty)
    }
    if row.kind == "chat_failed" { return ChatErrorCell.height(row, width: width, traits: traitCollection) }
    if row.kind == "tasksHeader" { return row.detail.isEmpty ? ChatFileCell.headerHeight : 56 }
    if row.subagent != nil { return ChatSubagentCell.height(row, width: width, traits: traitCollection) }
    if row.kind == "meta" { return 44 }
    if row.kind == "duration" { return ChatCell.processHeight(for: row, width: width, traits: traitCollection) }
    if row.kind == "changesHeader" { return ChatFileCell.headerHeight }  // Same height as the tasks row without a step.
    let measured = measure(row, width: width)
    if row.kind == "user" {
      return ChatMessageContent.height(textHeight: measured,
        limit: collapsedMessageHeights[row.entryID] ?? ChatMessageContent.maximumCollapsedHeight,
        expanded: expandedMessages.contains(row.entryID)) + ChatRowPadding.content + 12
    }
    let measuredHeight = measured + ChatCell.rowExtra(for: row, previousKind: previousKind ?? kind(before: row.id))
    // Process summaries sit close together (32 pt rows, the whole width taps); other actionable
    // rows keep the 44 pt floor.
    if row.kind == "summary" { return max(ChatCell.summaryHeight, measuredHeight) }
    let tapFloor = row.actionable || row.kind == "pending"
    if tapFloor { return max(44, measuredHeight) }
    if row.kind == "delivery" {
      return max(ChatCell.messageFont(for: row, compatibleWith: traitCollection).lineHeight, measuredHeight)
    }
    return measuredHeight
  }

  func kind(before id: String) -> String? {
    let ids = dataSource.snapshot().itemIdentifiers
    guard let index = ids.firstIndex(of: id), index > 0 else { return nil }
    return rows[ids[index - 1]]?.kind
  }

  func setAttachmentContext(_ json: String) {
    guard let data = json.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return }
    let workspace = value["workspaceId"] ?? "", session = value["sessionId"] ?? ""
    guard workspace != imageWorkspace || session != imageSession else { return }
    imageWorkspace = workspace; imageSession = session
    collection.reloadData()
  }

  func presenter() -> UIViewController? {
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController { return controller.presentedViewController ?? controller }
      responder = current.next
    }
    return window?.rootViewController
  }

  func deliverPendingContent() {
    guard window != nil, hasAppeared, !applying, !needsApply else { return }
    // The native optimistic row precedes the published local connection/queue state.
    // Start from that committed projection, not a destination that its echo moves.
    if let pendingSend, pendingSend.id == handoffID,
       publishedPendingID != pendingSend.id, !composerHasAcknowledgedSend { return }
    collection.layoutIfNeeded()
    let distance = followsBottom ? bottomOffset - collection.contentOffset.y : 0
    if let handoffID, followsBottom, abs(distance) > 0.5,
       ChatSendHandoff.isWaiting(id: handoffID) || ChatSendHandoff.hasWaitingAttachments(id: handoffID) {
      sendScroll = (CACurrentMediaTime(), collection.contentOffset.y)
      startMotion()
    }
    for cell in collection.visibleCells {
      if let attachments = cell as? ChatMessageAttachmentsCell {
        attachments.layoutIfNeeded()
        attachments.deliverPendingAttachments(scrollDistance: distance)
      }
      // A steered queue row flies under its own entry id, so any landed user row
      // with a waiting flight is a destination, not only the pending send.
      guard let cell = cell as? ChatCell, let row = cell.row, row.kind == "user",
            row.entryID == handoffID || ChatSendHandoff.isWaiting(id: row.entryID) else { continue }
      cell.layoutIfNeeded()
      let distance = followsBottom ? bottomOffset - collection.contentOffset.y : 0
      if ChatSendHandoff.isWaiting(id: row.entryID), followsBottom, abs(distance) > 0.5 {
        sendScroll = (CACurrentMediaTime(), collection.contentOffset.y)
        startMotion()
      }
      ChatSendHandoff.deliver(id: row.entryID, to: cell.messageContent, scrollDistance: distance)
    }
  }
}

@MainActor
private final class ChatMotionTarget: NSObject {
  weak var view: LodyChatView?
  init(_ view: LodyChatView) { self.view = view }
  @objc func tick(_ link: CADisplayLink) {
    guard let view else { link.invalidate(); return }
    view.advanceMotion(link)
  }
}

// Opt-in, offline fixture geometry only. No message text or account data leaves
// the view. The independent sampler observes UIKit, not the motion's targets.
@MainActor
final class ChatScrollProbe: NSObject {
  private let capturesOpening = LodyUIVerify.has("--ui-verify-opening")
  weak var view: LodyChatView?
  private var link: CADisplayLink?
  private var samples: [[String: Any]] = []
  private let id = UUID().uuidString
  private let started = CACurrentMediaTime()
  init(_ view: LodyChatView) {
    self.view = view
    super.init()
    let link = CADisplayLink(target: self, selector: #selector(sample(_:)))
    self.link = link
    link.add(to: .main, forMode: .common)
  }
  @objc private func sample(_ link: CADisplayLink) {
    guard let view, samples.count < 10800 else { stop(); return }
    guard capturesOpening || view.rows.keys.contains(where: { $0.hasPrefix("scroll-") || $0.hasPrefix("perf-") }) else { return }
    let list = view.collection
    var visible: [String: Any] = [:]
    for index in list.indexPathsForVisibleItems {
      guard let id = view.dataSource.itemIdentifier(for: index),
            capturesOpening || id.hasPrefix("scroll-") || id.hasPrefix("perf-"),
            let cell = list.cellForItem(at: index) else { continue }
      let frame = cell.layer.presentation()?.frame ?? cell.frame
      let offset = list.layer.presentation()?.bounds.minY ?? list.contentOffset.y
      visible[id] = ["y": frame.minY - offset, "height": frame.height]
    }
    samples.append(["t": link.timestamp - started, "offset": list.contentOffset.y,
      "bottom": view.bottomOffset, "top": -list.adjustedContentInset.top, "contentHeight": list.contentSize.height,
      "inset": list.adjustedContentInset.bottom, "following": view.followsBottom,
      "dragging": list.isDragging || list.isDecelerating,
      "touching": list.isTracking, "panY": list.panGestureRecognizer.translation(in: view.window).y,
      "paging": view.preparingHistory, "scrollingToTop": view.scrollingToTop,
      "loadingVisible": !view.empty.isHidden,
      "count": view.rows.count, "rows": visible])
  }
  func stop() {
    link?.invalidate(); link = nil
    guard !samples.isEmpty else { return }
    let report: [String: Any] = ["host": view?.processEntryID.isEmpty == false ? "process" : "chat", "samples": samples]
    if let data = try? JSONSerialization.data(withJSONObject: report) {
      try? data.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("lody-scroll-\(id).json"), options: .atomic)
    }
    samples.removeAll()
  }
}

// Measures main-run-loop delivery, not GPU presentation. No text is recorded.
@MainActor
final class ChatPerformanceProbe: NSObject {
  private weak var view: LodyChatView?
  private var link: CADisplayLink?
  private let requested = CACurrentMediaTime()
  private var started: Double = 0
  private var previous: Double = 0
  private var origin: CGFloat = 0
  private var samples: [[String: Double]] = []
  private var memory: [[String: Double]] = []
  private var nextMemory: Double = 0
  private var baseline = 0.0

  init(_ view: LodyChatView) {
    self.view = view
    super.init()
    view.scrollProbe?.stop(); view.scrollProbe = nil
    view.setNavigationSubtitle("Preparing · 20s · 8,000 pt/s")
    let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
    self.link = link
    link.add(to: .main, forMode: .common)
  }

  @objc private func tick(_ link: CADisplayLink) {
    guard let view, view.window != nil,
          UIApplication.shared.applicationState == .active else { stop(); return }
    let now = CACurrentMediaTime()
    let list = view.collection
    if started == 0 {
      guard now - requested < 300 else {
        view.setNavigationSubtitle("Benchmark failed: loading timeout")
        stop(); return
      }
      if view.hasEarlierHistory {
        // Benchmark setup traverses the same top-edge pagination as a reader.
        // The timed scrolling phase still runs against the complete dataset.
        view.setNavigationSubtitle("Loading history · \(view.rows.count) rows")
        view.pauseTracking()
        if !view.preparingHistory && !view.applying {
          list.setContentOffset(CGPoint(x: 0, y: -list.adjustedContentInset.top), animated: false)
          view.prefetchHistoryIfNeeded()
        }
        return
      }
      guard view.transcript.entries.count == 10_000,
            !view.preparingHistory,
            view.transcript.entries.first?.id == "perf-0",
            !view.applying, !view.rendering, !view.decoding,
            view.hasPositionedContent, view.motionLink == nil,
            now - requested >= 2 else { return }
      view.pauseTracking()
      list.setContentOffset(CGPoint(x: 0, y: view.bottomOffset), animated: false)
      origin = list.contentOffset.y
      started = now
      previous = now
      baseline = Self.footprint()
      memory.append(["t": 0, "mib": baseline])
      view.setNavigationSubtitle("Running · 20s · 8,000 pt/s")
      return
    }
    let elapsed = now - started
    let visible = list.indexPathsForVisibleItems.map(\.section)
    samples.append(["t": elapsed, "dt": now - previous,
      "budget": link.targetTimestamp - link.timestamp,
      "offset": list.contentOffset.y,
      "firstSection": Double(visible.min() ?? -1), "lastSection": Double(visible.max() ?? -1)])
    previous = now
    if elapsed >= nextMemory {
      memory.append(["t": elapsed, "mib": Self.footprint()])
      nextMemory = elapsed + 0.25
    }
    if elapsed >= 20 {
      finish(elapsed: elapsed)
      return
    }
    // A repeatable continuous scroll over the real production collection. The
    // dataset has 10k entries; this timed run does not claim to visit every row.
    let travel = min(elapsed, 20 - elapsed) * 8_000
    let target = max(-list.adjustedContentInset.top, origin - CGFloat(travel))
    list.setContentOffset(CGPoint(x: 0, y: target), animated: false)
  }

  private func finish(elapsed: Double) {
    guard let view else { stop(); return }
    let fps = Double(samples.count) / elapsed
    let peak = memory.map { $0["mib"]! }.max() ?? -1
    let report: [String: Any] = [
      "metric": "CADisplayLink main-run-loop FPS; not GPU presented FPS",
      "configuration": "Debug", "device": UIDevice.current.model,
      "systemVersion": UIDevice.current.systemVersion,
      "maximumFramesPerSecond": view.window?.screen.maximumFramesPerSecond ?? 0,
      "entries": view.transcript.entries.count, "rows": view.rows.count,
      "seconds": elapsed, "pointsPerSecond": 8000, "fps": fps,
      "baselineMiB": baseline, "peakMiB": peak, "endMiB": Self.footprint(),
      "memoryMetric": "App process TASK_VM_INFO phys_footprint; sampled every 250ms",
      "samples": samples, "memory": memory,
    ]
    do {
      let data = try JSONSerialization.data(withJSONObject: report, options: .sortedKeys)
      try data.write(to: FileManager.default.temporaryDirectory
        .appendingPathComponent("lody-chat-performance-\(UUID().uuidString).json"), options: .atomic)
      view.setNavigationSubtitle(String(format: "%.1f FPS · peak %.1f MiB", fps, peak))
    } catch {
      view.setNavigationSubtitle("Benchmark failed: report write error")
    }
    stop()
  }

  func stop() {
    link?.invalidate(); link = nil
    samples.removeAll(); memory.removeAll()
  }

  private static func footprint() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
  }
}


extension LodyChatView {
  func messageMenu(entryID: String, source: UIButton) -> UIMenu {
    UIMenu(children: [UIDeferredMenuElement.uncached { [weak self, weak source] completion in
      guard let self, let source,
        let content = ChatMessageShare.content(in: self.transcript, entryID: entryID) else {
        completion([])
        return
      }
      @MainActor func action(_ key: String, symbol: String, disabled: Bool = false) -> UIAction {
        UIAction(title: String(localized: String.LocalizationValue("native.chat.message." + key), bundle: .lody), image: UIImage(systemName: symbol),
          attributes: disabled ? .disabled : []) { [weak self, weak source] _ in
          guard let self, let source else { return }
          if key == "copy" {
            UIPasteboard.general.setMessageMarkdown(content.text)
            LodyToastOverlay.shared.show(message: String(localized: "native.chat.message.copied", bundle: .lody), kind: .neutral)
          } else if key == "image" {
            var snapshot = content
            snapshot.workspace = self.imageWorkspace
            snapshot.session = self.imageSession
            guard let data = try? JSONEncoder().encode(snapshot), let json = String(data: data, encoding: .utf8) else { return }
            self.onShareImage(["contentJSON": json])
          } else if let owner = self.presenter(), owner.presentedViewController == nil {
            let sheet = UIActivityViewController(activityItems: [content.text], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = source
            sheet.popoverPresentationController?.sourceRect = source.bounds
            owner.present(sheet, animated: true)
          }
        }
      }
      completion([
        action("copy", symbol: "doc.on.doc", disabled: content.text.isEmpty),
        action("image", symbol: "photo", disabled: !self.imageSharingEnabled),
        action("share", symbol: "square.and.arrow.up", disabled: content.text.isEmpty),
      ])
    }])
  }
}
