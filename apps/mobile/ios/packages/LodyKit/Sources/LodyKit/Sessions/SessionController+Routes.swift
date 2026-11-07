import UIKit

extension SessionController {
  func wireRouteEvents() {
    chat.onForkMessage = { [weak self] body in
      guard let self, let id = body["entryId"] as? String else { return }
      let page = MessageForkController(sessionId: self.sessionId, entryId: id)
      LodyShell.shared.presentNative(page, title: String(localized: "message.fork.title", bundle: .lody), detents: [0.5, 1], grabber: true)
    }
    chat.turnInfoEnabled = true
    chat.imageSharingEnabled = true
    chat.onShareImage = { [weak self] body in
      self?.open("message-share", ["contentJSON": body["contentJSON"] as? String ?? ""], present: true)
    }
    chat.onActivityPress = { [weak self] body in
      guard let self, let entryId = body["entryId"] as? String, let itemId = body["itemId"] as? String else { return }
      if body["processStartId"] as? String == "__taskSheet__" { openTasks(entryId: entryId) }
      else if body["processStartId"] as? String == "__turnFiles__" { openTurnFiles(entryId: entryId) }
      else if itemId.isEmpty { openProcess(entryId: entryId, startItemId: body["processStartId"] as? String ?? "") }
      else { activity(entryId: entryId, itemId: itemId) }
    }
    chat.onFilePress = { [weak self] body in
      self?.openFile(body["path"] as? String ?? "", line: (body["line"] as? NSNumber)?.intValue ?? 0)
    }
    chat.onTurnChangesPress = { [weak self] body in
      guard let self, let path = body["path"] as? String else { return }
      // Displayed native rows can lag the replica; the diff page validates its target.
      self.open("file-diff", ["sessionId": self.sessionId, "entryId": body["entryId"] as? String ?? "", "path": path],
                title: (path as NSString).lastPathComponent)
    }
  }

  var localProjectId: String? {
    guard let projectId = source.state.catalog.session(sessionId)?.projectId,
          let range = projectId.range(of: ":local:"), range.lowerBound > projectId.startIndex else { return nil }
    return String(projectId[range.upperBound...])
  }

  var reviewable: Bool {
    let projectId = source.state.catalog.session(sessionId)?.projectId ?? ""
    return workspaceAvailable && (localProjectId != nil || projectId.hasPrefix("github:"))
  }

  var browsable: Bool { workspaceAvailable && localProjectId != nil }

  private var workspaceAvailable: Bool {
    let creating = sender?.record?.creation != nil
    return !source.state.workspaceId.isEmpty && !creating && source.state.catalog.session(sessionId)?.archived == false
  }

  func openProjectFiles(title: String) {
    guard browsable else { return }
    let state = source.state
    open("files", ["workspaceId": state.workspaceId, "sessionId": sessionId, "userId": state.userId, "path": "", "title": title])
  }

  func openWorkspaceChanges() {
    guard reviewable else { return }
    open("workspace-changes", ["sessionId": sessionId])
  }

  private func openProcess(entryId: String, startItemId: String) {
    let page = ProcessController(entryId: entryId, startItemId: startItemId)
    processPage = page
    page.update(feed?.state.entriesJSON ?? "[]")
    page.onActivity = { [weak self, weak page] entry, item in self?.activity(entryId: entry, itemId: item, from: page) }
    page.onFile = { [weak self, weak page] path, line in self?.openFile(path, line: line, from: page) }
    LodyShell.shared.presentNative(
      page, title: String(localized: String.LocalizationValue(startItemId == "__tasks__" ? "process.tasks" : "process.title"), bundle: .lody),
      detents: [0.6, 1], grabber: true
    )
  }

  /// A turn's tasks in a near full-screen sheet; a row pushes its run inside the sheet.
  private func openTasks(entryId: String) {
    let page = TasksController(entryId: entryId)
    tasksPage = page
    page.update(feed?.state.entriesJSON ?? "[]")
    page.onOpen = { [weak self, weak page] itemId in self?.activity(entryId: entryId, itemId: itemId, from: page) }
    LodyShell.shared.presentNative(page, title: String(localized: "process.tasks", bundle: .lody), detents: [1], grabber: true)
  }

  /// A turn's changed files in a near full-screen sheet; a file pushes its diff inside the sheet.
  private func openTurnFiles(entryId: String) {
    let page = TurnFilesController(entryId: entryId)
    page.update(feed?.state.entriesJSON ?? "[]")
    page.onOpen = { [weak self, weak page] path in
      guard let self, let page else { return }
      LodyShell.shared.pushNative("file-diff", title: (path as NSString).lastPathComponent,
        params: ["sessionId": self.sessionId, "entryId": entryId, "path": path], from: page)
    }
    // Titled like the row that opened it ("3 files").
    let title = String.localizedStringWithFormat(String(localized: "native.chat.transcript.fileCount", bundle: .lody), page.fileCount)
    LodyShell.shared.presentNative(page, title: title, detents: [1], grabber: true)
  }

  private func activity(entryId: String, itemId: String, from source: UIViewController? = nil) {
    let item = Self.item(in: feed?.state.entriesJSON ?? "[]", entryId: entryId, itemId: itemId)
    if item?["type"] as? String == "system_notice", item?["name"] as? String == "chat_failed" {
      open("agent-error", item?["meta"] as? [String: Any] ?? [:], present: true, from: source)
      return
    }
    guard feed?.state.status == "live" else {
      let alert = UIAlertController(
        title: String(localized: "session.alert.syncing.title", bundle: .lody), message: String(localized: "session.alert.syncing.message", bundle: .lody),
        preferredStyle: .alert
      )
      alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default))
      (source ?? self).present(alert, animated: true)
      return
    }
    guard let item else { return }
    if let permission = item["permission"] as? [String: Any], permission["pending"] as? Bool == true {
      do {
        openPermission(try SessionPermission.target(entryId: entryId, item: item, permission: permission))
      } catch {
        openPermission(nil)
        permissionPage?.showInvalidRequest(error.localizedDescription)
      }
      return
    }
    if item["type"] as? String == "subagent_task" {
      let page = SubagentTaskController(entryId: entryId, item: item)
      subagentPage = page
      page.onActivity = { [weak self, weak page] entry, item in self?.activity(entryId: entry, itemId: item, from: page) }
      page.onFile = { [weak self, weak page] path, line in self?.openFile(path, line: line, from: page) }
      let title = String(localized: "native.chat.transcript.subtask", bundle: .lody)
      if source is ProcessController, let modal = source?.navigationController, modal.presentingViewController != nil {
        // Activity is transient; its selected task belongs to the session's detail stack.
        modal.dismiss(animated: true) { [weak self] in
          guard let self, self.view.window != nil else { return }
          LodyShell.shared.presentDetail(page, title: title, from: self, push: true)
        }
      } else { LodyShell.shared.presentDetail(page, title: title, from: source ?? self, push: true) }
      return
    }
    let page = ItemDetailController(sessionId: sessionId, entryId: entryId, itemIds: [itemId], generation: feed?.generation ?? 0,
                                    service: itemDetailService)
    LodyShell.shared.presentNative(page, title: String(localized: "detail.title", bundle: .lody), detents: [0.6, 1], grabber: true)
  }

  private func openFile(_ path: String, line: Int, from source: UIViewController? = nil) {
    guard !openingFile, !path.isEmpty else { return }
    openingFile = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      defer { self.openingFile = false }
      var opened = false
      if let runtime = DataRuntime.current {
        opened = await FilePreview.open(sessionId: self.sessionId, path: path, line: line, runtime: runtime, from: source ?? self)
      }
      guard !opened, (source ?? self).view.window != nil else { return }
      self.open("file-content", ["sessionId": self.sessionId, "path": path, "line": line], present: true, from: source)
    }
  }

  func open(_ page: String, _ params: [String: Any], present: Bool = false, title: String? = nil, from source: UIViewController? = nil) {
    guard let content = LodyNativePages.make(page, params: Self.json(params)) else {
      preconditionFailure("Missing native session page: \(page)")
    }
    let titles = ["files": "files.title", "workspace-changes": "workspaceChanges.title", "file-diff": "diff.title"]
    let name = title ?? content.title ?? titles[page].map { String(localized: String.LocalizationValue($0), bundle: .lody) } ?? ""
    if ["file-content", "file-diff", "files", "workspace-changes"].contains(page) {
      LodyShell.shared.presentDetail(content, title: name, from: source ?? self, push: !present, detents: [1])
    } else if present { LodyShell.shared.presentNative(content, title: name, grabber: true) }
    else { LodyShell.shared.pushNative(content, title: name, from: source ?? self) }
  }

  static func item(in entriesJSON: String, entryId: String, itemId: String) -> [String: Any]? {
    let entries = (try? JSONSerialization.jsonObject(with: Data(entriesJSON.utf8))) as? [[String: Any]] ?? []
    let items = entries.first { $0["id"] as? String == entryId }?["items"] as? [[String: Any]] ?? []
    return items.flatMap { item in
      [item] + ((item["run"] as? [String: Any])?["items"] as? [[String: Any]] ?? [])
    }.first { $0["itemId"] as? String == itemId }
  }
}

extension SessionController {
  func wireMentionEvents() {
    chat.onMentionBrowse = { [weak self] body in self?.browseMentions(body) }
  }

  func renderMentions(_ state: SessionListState, _ session: SessionItem) {
    guard !state.workspaceId.isEmpty, !state.userId.isEmpty else {
      guard mentions != nil else { return }
      mentions = nil
      chat.composer.setMentionItems("null")
      return
    }
    let source = MentionSource(
      workspaceId: state.workspaceId, sessionId: sessionId, cliType: session.cliType, agentType: session.agentType
    )
    guard mentions?.source != source else { return }
    let store = MentionCatalogStore(source: source)
    store.changed = { [weak self, weak store] in
      guard let self, let store, mentions === store else { return }
      chat.composer.setMentionItems(store.composerItemsJSON())
    }
    mentions = store
    chat.composer.setMentionItems(store.composerItemsJSON())
    store.preload()
  }

  private func browseMentions(_ body: [String: Any]) {
    guard let store = mentions, let category = body["category"] as? String,
          MentionCatalogStore.categories.contains(category) else { return }
    let picker = MentionPickerController(
      category: category, query: body["query"] as? String ?? "", store: store, initial: store.catalog(category)
    ) { [weak self, weak store] item in
      guard let self, let store, mentions === store else { return }
      mentionSequence += 1
      let result: [String: Any] = [
        "id": String(mentionSequence), "path": item.path,
        "item": (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(item))) ?? NSNull(),
      ]
      chat.composer.setMentionResult(Self.json(result))
      if let page = parent, let container = page.navigationController { container.popToViewController(page, animated: true) }
    }
    LodyShell.shared.pushNative(
      picker, title: String(localized: String.LocalizationValue("native.chat.mention." + (ChatMentionItem.labels[category] ?? category)), bundle: .lody), from: parent ?? self
    )
  }
}
