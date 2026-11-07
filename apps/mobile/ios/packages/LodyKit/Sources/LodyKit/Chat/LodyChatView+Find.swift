import UIKit

struct ChatFindMatch: Equatable {
  let rowID: String
  let ordinal: Int
}

extension LodyChatView {
  func setFindRequest(_ json: String) {
    guard json != lastFindRequest else { return }
    lastFindRequest = json
    guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
    guard object["open"] as? Bool == true else { closeFind(); return }
    openFind(query: object["query"] as? String ?? "", keyboard: object["keyboard"] as? Bool == true)
  }

  func openFind(query: String, keyboard: Bool) {
    layoutIfNeeded()
    if findBar.isHidden { findBar.alpha = 0 }
    findBar.isHidden = false
    findPresented = true
    if hasPositionedContent { pauseTracking() }
    findBar.field.text = query
    findFocusRequest = keyboard
    findNeedsInitialPosition = true
    findSelection = nil
    findBar.changed = { [weak self] in
      self?.findNeedsInitialPosition = true
      self?.findSelection = nil
      self?.refreshFind()
    }
    findBar.move = { [weak self] in self?.moveFind($0) }
    findBar.dismiss = { [weak self] in self?.closeFind() }
    setNeedsLayout()
    animateFind()
    if !updateDeferredStreams() { refreshFind() }
  }

  func closeFind() {
    guard findPresented else { return }
    layoutIfNeeded()
    findPresented = false
    findBar.field.resignFirstResponder()
    findMatches = []
    findSelection = nil
    findNeedsInitialPosition = false
    findFocusRequest = nil
    for view in findHighlightedViews.allObjects { ChatFindHighlight.apply(to: view, query: "", active: nil) }
    findHighlightedViews.removeAllObjects()
    setNeedsLayout()
    animateFind()
  }

  private func animateFind() {
    UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.25,
      delay: 0, options: [.beginFromCurrentState, .curveEaseInOut, .allowUserInteraction]) {
      self.findBar.alpha = self.findPresented ? 1 : 0
      self.layoutIfNeeded()
    } completion: { finished in
      if finished, !self.findPresented { self.findBar.isHidden = true }
    }
  }

  func layoutFind() {
    let height: CGFloat = findPresented ? findBar.preferredHeight : 0
    findBar.frame = CGRect(x: safeAreaInsets.left, y: safeAreaInsets.top,
      width: bounds.width - safeAreaInsets.left - safeAreaInsets.right, height: height)
    if collection.contentInset.top != height {
      let offset = collection.contentOffset
      collection.contentInset.top = height
      collection.contentOffset = offset
    }
    collection.verticalScrollIndicatorInsets.top = height
    if let keyboard = findFocusRequest, let window {
      findFocusRequest = nil
      if keyboard { findBar.field.becomeFirstResponder() }
      else { window.endEditing(true) }
    }
    refreshFindHighlights()
  }

  func refreshFind() {
    guard findPresented, !applying else { return }
    let query = (findBar.field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let ids = dataSource.snapshot().itemIdentifiers
    let oldSelection = findSelection
    findMatches = ids.flatMap { id -> [ChatFindMatch] in
      guard let row = rows[id], ["user", "text", "thought", "proposed_plan"].contains(row.kind) else { return [] }
      let text = SessionProse.text(row.text, role: row.kind == "user" ? "user" : "assistant")
      return TextSearch.ranges(in: text, query: query).indices.map { ChatFindMatch(rowID: id, ordinal: $0) }
    }
    if let oldSelection, findMatches.contains(oldSelection) { findSelection = oldSelection }
    else { findSelection = findMatches.last }
    findBar.update(current: findSelection.flatMap { findMatches.firstIndex(of: $0) }.map { $0 + 1 } ?? 0,
      total: findMatches.count, partial: hasEarlierHistory)
    refreshFindHighlights()
    if findNeedsInitialPosition, !ids.isEmpty {
      findNeedsInitialPosition = false
      // TODO: Extend the history window when supporting older search targets.
      // ponytail: navigate expanded rows in this window only; otherwise keep the latest result.
      if findSelection != nil { scrollToFind() }
    }
  }

  func moveFind(_ direction: Int) {
    guard !findMatches.isEmpty else { return }
    let current = findSelection.flatMap { findMatches.firstIndex(of: $0) } ?? 0
    findSelection = findMatches[(current + direction + findMatches.count) % findMatches.count]
    findBar.update(current: (findMatches.firstIndex(of: findSelection!) ?? 0) + 1,
      total: findMatches.count, partial: hasEarlierHistory)
    scrollToFind()
  }

  private func scrollToFind() {
    guard let match = findSelection, let index = dataSource.indexPath(for: match.rowID) else { return }
    pauseTracking()
    if rows[match.rowID]?.kind == "proposed_plan", expandedPlans.insert(match.rowID).inserted {
      rowHeights[match.rowID] = nil
      (collection.cellForItem(at: index) as? ChatPlanCell)?.expanded = true
      collection.collectionViewLayout.invalidateLayout()
    }
    layoutIfNeeded()
    collection.scrollToItem(at: index, at: .centeredVertically, animated: false)
    collection.layoutIfNeeded()
    refreshFindHighlights()
    if let cell = collection.cellForItem(at: index),
       let rect = ChatFindHighlight.apply(to: cell.contentView,
         query: (findBar.field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines), active: match.ordinal, reveal: true) {
      collection.scrollRectToVisible(cell.contentView.convert(rect, to: collection).insetBy(dx: 0, dy: -12), animated: false)
    }
  }

  func refreshFindHighlights() {
    // Clip behind search without changing scroll geometry during keyboard dismissal.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    findClip.backgroundColor = UIColor.black.cgColor
    findClip.frame = collection.bounds.inset(by: UIEdgeInsets(
      top: findPresented ? findBar.frame.maxY : 0, left: 0, bottom: 0, right: 0))
    collection.layer.mask = findPresented ? findClip : nil
    CATransaction.commit()
    guard findPresented else { return }
    let query = (findBar.field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    for cell in collection.visibleCells {
      guard let index = collection.indexPath(for: cell), let id = dataSource.itemIdentifier(for: index) else { continue }
      let searchable = rows[id].map { ["user", "text", "thought", "proposed_plan"].contains($0.kind) } == true
      findHighlightedViews.add(cell.contentView)
      ChatFindHighlight.apply(to: cell.contentView, query: searchable ? query : "",
        active: findSelection?.rowID == id ? findSelection?.ordinal : nil)
    }
  }
}
