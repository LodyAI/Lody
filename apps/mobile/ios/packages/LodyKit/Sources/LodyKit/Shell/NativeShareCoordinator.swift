import LodyCore
import UIKit

@MainActor
final class NativeShareCoordinator {
  private var drain: Task<Void, Never>?
  private var form: LodyPageController?
  private var prefetch: Task<Void, Never>?
  private var failed: Set<String> = []
  private var scope = ""
  private var catalogJSON = ""
  private var optionsKey = ""

  func wake() {
    failed.removeAll()
    reconcile()
  }

  func stop() {
    drain?.cancel(); drain = nil; prefetch?.cancel(); prefetch = nil
    if let form { LodyShell.shared.close(from: form) }
    scope = ""; optionsKey = ""; catalogJSON = ""
  }

  func reconcile() {
    let state = SessionSource.live.state
    guard !state.key.isEmpty else {
      stop()
      return
    }
    if scope != state.key {
      drain?.cancel(); drain = nil; prefetch?.cancel()
      if let form { LodyShell.shared.close(from: form) }
      scope = state.key; failed.removeAll(); optionsKey = ""
    }
    snapshot(state)
    guard drain == nil else { return }
    drain = Task { [weak self] in
      guard let self else { return }
      defer { if !Task.isCancelled { drain = nil } }
      for entry in ShareStore.pending() where !failed.contains(entry.id) {
        guard !Task.isCancelled else { return }
        let account = AuthSession.shared.snapshot.account
        switch ShareInboxRouting.resolve(user: account?.user.id ?? "", workspaces: account?.workspaces.map(\.id) ?? [],
          selected: state.workspaceId, loading: state.loading, entryUser: entry.userId, entryWorkspace: entry.workspaceId) {
        case .discard: ShareStore.remove(entry.id); continue
        case .workspace(let id):
          CatalogSession.shared.selectWorkspace(id)
          DispatchQueue.main.async { [weak self] in self?.reconcile() }
          return
        case .wait: return
        case .deliver: break
        }
        await deliver(entry, scope: state.key)
      }
    }
  }

  private func snapshot(_ state: SessionListState) {
    let index = UserDefaults.standard.integer(forKey: "inboxProjectSort")
    let sort = InboxSort.allCases.indices.contains(index) ? InboxSort.allCases[index] : .name
    let projects = InboxSections.sortProjects(state.catalog.projects, sessions: state.catalog.sessions, sort: sort)
      .filter { !SessionRows.isChat($0.id) }
      .map { CreateProject(id: $0.id, machineId: $0.machineId, name: $0.name, rootPath: $0.rootPath) }
    let catalog = ShareCatalog(userId: state.userId, workspaceId: state.workspaceId, projects: projects, machineNames: state.catalog.machineNames)
    let json = CreateJSON.encode(catalog)
    if json != catalogJSON {
      do { try ShareStore.writeCatalog(json); catalogJSON = json }
      catch { report(error, operation: "snapshot") }
    }
    guard !state.loading, state.connected else { return }
    let key = state.key + ":" + projects.prefix(10).map(\.id).joined(separator: ",")
    guard key != optionsKey else { return }
    optionsKey = key
    prefetch?.cancel()
    prefetch = Task { [weak self] in
      for project in [nil] + projects.prefix(10).map({ Optional($0.id) }) {
        guard !Task.isCancelled, SessionSource.live.state.key == state.key else { return }
        do {
          let options = try await CreateSessionService.live.options(state.workspaceId, project)
          guard !Task.isCancelled, SessionSource.live.state.key == state.key else { return }
          try ShareStore.writeOptions(options, target: project ?? "chat")
        } catch { self?.report(error, operation: "options") }
      }
    }
  }

  private func deliver(_ entry: ShareManifest, scope: String) async {
    let adopted: ShareManifest
    do { adopted = try ShareStore.adopt(entry.id) }
    catch {
      ShareStore.remove(entry.id)
      toast("shareInbox.unreadable")
      report(error, operation: "adopt")
      return
    }
    var available = adopted.draft != nil
    if let draft = adopted.draft {
      do {
        let options = try await CreateSessionService.live.options(draft.workspaceId, draft.projectId)
        available = options.agents.contains { $0.id == draft.agent.id && $0.machineId == draft.agent.machineId }
        if let model = draft.choice.modelId, !model.isEmpty {
          let capability = CreateLogic.capability(
            in: options.capabilities, machineId: draft.agent.machineId, configId: draft.agent.id,
            cliType: draft.agent.cliType, agentType: draft.agent.agentType)
          available = available && capability?.models.contains { $0.id == model } == true
        }
      } catch {
        // An unavailable network does not invalidate a cached selection: the ordinary outbox owns its failure and draft restoration.
        report(error, operation: "selection")
      }
    }
    guard !Task.isCancelled, SessionSource.live.state.key == scope else { return }
    guard available, let draft = adopted.draft else {
      do {
        var fields: [String: Any] = ["workspaceId": adopted.workspaceId, "context": adopted.context,
          "draft": ["text": adopted.text, "attachmentsJSON": CreateJSON.encode(adopted.attachments)], "sheet": true]
        if let project = adopted.projectId { fields["projectId"] = project }
        let page = try SessionNavigation.handle("create", fields)!
        form = page
        ShareStore.remove(entry.id)
        await withCheckedContinuation { done in
          page.onClose = { [weak self, weak page] in
            if self?.form === page { self?.form = nil }
            done.resume()
          }
        }
      } catch { failed.insert(entry.id); report(error, operation: "form") }
      return
    }
    let attachments = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(adopted.attachments))
    let record = CreateDraftRecord(draft: draft, payload: ["id": entry.id.lowercased(), "text": adopted.text,
      "startedAt": Date().timeIntervalSince1970 * 1000, "attachments": attachments])
    do { try await OutboxSession.shared.put(user: adopted.userId, workspace: adopted.workspaceId, json: record.recordJSON).value }
    catch { failed.insert(entry.id); toast("shareInbox.saveFailed"); report(error, operation: "persist"); return }
    ShareStore.remove(entry.id)
    guard !Task.isCancelled, SessionSource.live.state.key == scope else { return }
    LodyShell.shared.openSessionFromExternal(draft.sessionId)
  }

  private func toast(_ key: String) { LodyToastOverlay.shared.show(message: String(localized: String.LocalizationValue(key), bundle: .lody), kind: .error) }
  private func report(_ error: Error, operation: String) {
    DiagnosticsStore.shared.record("share", "failed", fields: ["operation": operation, "error": error.localizedDescription])
  }
}
