import LodyCore
import SafariServices
import UIKit

extension SessionController {
  func prepareSimulator(_ state: SessionListState, _ session: SessionItem) {
    guard simulator == nil, state.catalog.machineSimulators[session.machineId] != nil else { return }
    let store = SessionSimulator(sessionId: sessionId,
      service: simulatorService ?? .live(workspaceId: state.workspaceId, userId: state.userId, sessionId: sessionId))
    simulator = store
    store.watch(self) { [weak self, weak store] in
      guard let self, let store else { return }
      chat.setSimulatorPreview(store.previewJSON)
      renderComposer()
      render()
    }

  }

  func simulatorMenu() -> [UIMenuElement] {
    guard let session = source.state.catalog.session(sessionId),
      let availability = source.state.catalog.machineSimulators[session.machineId] else { return [] }
    let action = UIAction(title: String(localized: "simulator.menu", bundle: .lody), image: UIImage(systemName: "iphone")) { [weak self] _ in self?.openSimulator() }
    if availability == "upgrade-required" { action.subtitle = String(localized: "simulator.upgradeRequired", bundle: .lody) }
    else if let simulator, simulator.running { action.subtitle = simulator.phaseText + " · " + simulator.name }
    return [action]
  }

  func openSimulator() {
    guard !openingSimulator, let session = source.state.catalog.session(sessionId), let simulator else { return }
    if source.state.catalog.machineSimulators[session.machineId] == "upgrade-required" {
      let alert = UIAlertController(title: String(localized: "simulator.menu", bundle: .lody), message: String(localized: "simulator.upgradeRequired", bundle: .lody), preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default)); present(alert, animated: true); return
    }
    openingSimulator = true
    Task { [weak self] in
      guard let self else { return }
      defer { openingSimulator = false }
      do {
        simulator.revealPreview()
        if simulator.running { showSimulator(); return }
        if try await simulator.resume() { showSimulator(); return }
        let picker = SimulatorPickerController(store: simulator) { [weak self] device in
          simulator.start(device); self?.showSimulator()
        }
        LodyShell.shared.presentNative(picker, title: String(localized: "simulator.choose", bundle: .lody), grabber: true)
      } catch { toolError(error) }
    }
  }
  private func showSimulator() {
    guard let simulator else { return }
    LodyShell.shared.pushNative(SimulatorController(store: simulator), title: simulator.name, from: self)
  }
  private func toolError(_ error: Error) { LodyToastOverlay.shared.show(message: error.localizedDescription, kind: .error) }

  static func livePullRequest(_ reference: SessionPullRequest, _ state: SessionListState) -> PullRequestController {
    let scope = SettingsActor.live(["workspaceId": state.workspaceId, "userId": state.userId])
    let store = PullRequestStore(repository: reference.repository, number: reference.number, scope: scope,
      service: .live(workspaceId: state.workspaceId, repository: reference.repository, number: reference.number))
    return PullRequestController(store: store)
  }

  func openPullRequest(_ reference: SessionPullRequest) {
    // One tap on a transcript link can be delivered twice (as with file links); keep one
    // page per PR until it closes, while a different PR still opens normally.
    let key = "\(reference.repository.lowercased())#\(reference.number)"
    guard openPullRequests.insert(key).inserted else { return }
    let state = source.state
    let page = pullRequestPage(reference, state)
    page.investigate = { [weak self] text in
      guard let self, source.state.key == state.key else { throw OutboxError.scopeExpired }
      chat.composer.appendDraft(Self.json(["id": UUID().uuidString, "text": text]))
    }
    // A panel over the conversation (sheet with detents; the inspector on iPad), not a push.
    LodyShell.shared.presentDetail(page, title: "PR #\(reference.number)", from: self) { [weak self] in
      self?.openPullRequests.remove(key)
    }
  }

  /// A PR link in the conversation opens the native PR page when it belongs to the session's
  /// project (a multi-repository project's members included); others stay in the browser.
  func openPullRequestLink(_ link: ChatPullRequestLink) -> Bool {
    let catalog = source.state.catalog
    guard let session = catalog.session(sessionId) else { return false }
    let repositories = catalog.projects.first { $0.id == session.projectId }?.githubRepositories
      ?? (session.projectId.hasPrefix("github:") ? [String(session.projectId.dropFirst(7))] : [])
    guard let repository = repositories.first(where: { $0.caseInsensitiveCompare(link.repository) == .orderedSame }) else { return false }
    let known = session.pullRequests.last {
      $0.number == link.number && $0.repository.caseInsensitiveCompare(repository) == .orderedSame
    }
    openPullRequest(known ?? SessionPullRequest(repository: repository, number: link.number, status: "", ci: nil, url: link.url))
    return true
  }

  func updateDetails(_ json: String) { subagentPage?.update(json) }

}

extension SessionController {
  /// Live resources as action bar icons: tap opens, the menu copies or stops.
  var browserItem: [String: Any]? {
    guard let preview = feed?.state.preview else { return nil }
    var actions: [[String: Any]] = [["id": "copy", "title": String(localized: "session.preview.copyLink", bundle: .lody), "symbol": "link"]]
    if preview.active { actions.append(["id": "stop", "title": String(localized: "session.preview.stop", bundle: .lody), "symbol": "stop.circle", "destructive": true]) }
    return ["id": "browser", "symbol": "safari", "busy": browserBusy, "tap": true, "tint": "primary", "menuTitle": preview.label, "actions": actions,
      "accessibilityLabel": String.localizedStringWithFormat(String(localized: "session.preview.open", bundle: .lody), String(describing: preview.label))]
  }

  var simulatorItem: [String: Any]? {
    guard let session = source.state.catalog.session(sessionId),
      source.state.catalog.machineSimulators[session.machineId] == "available", let simulator,
      session.iosSimulatorPreviewRequestId != nil || simulator.running else { return nil }
    let name = simulator.running ? simulator.name : String(localized: "simulator.menu", bundle: .lody)
    var item: [String: Any] = ["id": "simulator", "symbol": "iphone", "busy": simulator.connecting, "tap": true, "tint": "primary", "menuTitle": name,
      "accessibilityLabel": String.localizedStringWithFormat(String(localized: "simulator.chip.open", bundle: .lody), String(describing: name))]
    item["actions"] = simulator.running ? [["id": "stop", "title": String(localized: "simulator.stop", bundle: .lody), "symbol": "stop.circle", "destructive": true]] : []
    return item
  }

  func contextAction(_ action: String) {
    if action.hasPrefix("bar:") { infoBarAction(String(action.dropFirst(4))); return }
    // The floating simulator preview's own actions.
    if action == "expand" { openSimulator(); return }
    if action == "close" { simulator?.hidePreview(); return }
    resourceAction("simulator", action)
  }

  func resourceAction(_ resource: String, _ action: String) {
    if resource == "browser" { browserAction(action); return }
    if action == "stop" {
      Task { do { try await simulator?.stop() } catch { toolError(error) } }
    } else { openSimulator() }
  }

  private func browserAction(_ action: String) {
    guard !browserBusy else { return }
    let state = source.state
    browserBusy = true; renderComposer()
    Task { [weak self] in
      guard let self else { return }
      defer { browserBusy = false; renderComposer() }
      do {
        let command: RuntimeContract.SessionPreviewParamsAction = action == "stop" ? .revoke : .create
        let reply = try await requestBrowserPreview(state, command)
        guard source.state.key == state.key else { throw OutboxError.scopeExpired }
        guard viewIfLoaded?.window != nil else { return }
        if let error = reply.error {
          let message = error == "unsupported" ? String(localized: "session.preview.unsupported", bundle: .lody) : reply.message ?? String(localized: "session.preview.generic", bundle: .lody)
          throw SettingsError(message)
        }
        if action == "stop" { LodyToastOverlay.shared.show(message: String(localized: "session.preview.stopped", bundle: .lody), kind: .neutral); return }
        guard let address = reply.url, let url = URL(string: address), url.scheme == "https", url.user == nil, url.password == nil,
              url.host?.hasSuffix(".trycloudflare.com") == true else { throw SettingsError(String(localized: "session.preview.generic", bundle: .lody)) }
        if action == "copy" {
          UIPasteboard.general.string = address
          LodyToastOverlay.shared.show(message: String(localized: "session.preview.copied", bundle: .lody), kind: .neutral)
        } else { present(SFSafariViewController(url: url), animated: true) }
      } catch {
        guard viewIfLoaded?.window != nil else { return }
        let alert = UIAlertController(title: String(localized: "session.preview.failed", bundle: .lody), message: String(describing: error), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default)); present(alert, animated: true)
      }
    }
  }
}
