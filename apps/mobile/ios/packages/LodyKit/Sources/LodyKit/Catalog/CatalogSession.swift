import Foundation
import LodyCore

@MainActor
final class CatalogSession {
  static let shared = CatalogSession()
  nonisolated static let published = CatalogPublished()

  private final class Watch {
    let owner: String
    let key: String
    let workspaceId: String
    let generation: Int
    var received = false
    var saveErrorShown = false
    var state = "syncing"
    var machines = 0
    var syncedAt: Int?

    init(owner: String, key: String, workspaceId: String, generation: Int) {
      self.owner = owner
      self.key = key
      self.workspaceId = workspaceId
      self.generation = generation
    }
  }

  private struct Trigger: Equatable {
    let userId: String
    let key: String
    let refresh: Int
    let localReady: Bool
  }

  private weak var runtime: DataRuntime?
  private var observer: NSObjectProtocol?
  private var choice = (user: "", workspace: "")
  private var trigger: Trigger?
  private var refreshes = 0
  private var owners = 0
  private var watch: Watch?
  private var snapshot = CatalogSnapshot()
  private var raw = "null"
  private var latestUserMessages: [String: String] = [:]

  func attach(_ runtime: DataRuntime) {
    if self.runtime !== runtime {
      self.runtime?.onCatalogUpdate = nil
      self.runtime?.onMachinePresence = nil
      self.runtime = runtime
      runtime.onCatalogUpdate = { [weak self] owner, state, catalog in
        self?.receive(owner: owner, state: state, catalog: catalog)
      }
      runtime.onMachinePresence = { [weak self] owner, presence in
        self?.receive(owner: owner, presence: presence)
      }
      trigger = nil
    }
    if observer == nil {
      observer = NotificationCenter.default.addObserver(forName: .lodyAuthDidChange, object: nil, queue: nil) { _ in
        MainActor.assumeIsolated { CatalogSession.shared.reconcile() }
      }
    }
    reconcile()
  }

  func selectWorkspace(_ id: String) {
    guard let account = AuthSession.shared.catalogScope.account else { return }
    choice = (account.user.id, id)
    let key = "workspace:\(account.user.id)"
    let generation = LocalStore.shared.generation
    let value = (try? JSONSerialization.data(withJSONObject: id, options: [.fragmentsAllowed, .withoutEscapingSlashes]))
      .map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
    LocalStore.queue.async {
      do { try LocalStore.shared.write(key, value, generation: generation) } catch {
        DispatchQueue.main.async {
          MainActor.assumeIsolated { CatalogSession.shared.toast("catalog.toast.workspaceSaveFailed") }
        }
      }
    }
    reconcile()
  }

  func refresh() {
    refreshes += 1
    reconcile()
  }

  private func reconcile() {
    guard let runtime else { return }
    let scope = AuthSession.shared.catalogScope
    let account = scope.account
    let userId = account?.user.id ?? ""
    let workspaceId = !userId.isEmpty && choice.user == userId ? choice.workspace : scope.initialWorkspace
    let selected = account?.workspaces.first { $0.id == workspaceId } ?? account?.workspaces.first
    let key = selected.map { "catalog:\(userId):\($0.id)" } ?? ""
    let next = Trigger(userId: userId, key: key, refresh: refreshes, localReady: scope.localReady)
    guard trigger != next else { return }
    trigger = next
    let previous = watch
    watch = nil
    if let previous { runtime.stop(owner: previous.owner) }
    snapshot.userId = userId
    snapshot.workspaceId = selected?.id ?? ""
    snapshot.presence = CatalogPresence(workspaceId: selected?.id ?? "")
    guard let account, let selected else {
      setCatalog("null", sessions: [:])
      snapshot.key = ""
      snapshot.loading = false
      snapshot.connected = false
      snapshot.syncedAt = nil
      if scope.localReady { snapshot.connection = CatalogConnection(state: "offline", machines: 0) }
      publish()
      return
    }
    owners += 1
    let watch = Watch(owner: "catalog-\(owners)", key: key, workspaceId: selected.id, generation: LocalStore.shared.generation)
    self.watch = watch
    let seed = selected.id == scope.initialWorkspace ? SavedCatalogDigest.decode(scope.initialCatalog) : nil
    watch.syncedAt = seed?.syncedAt
    watch.machines = seed?.catalog.machineIds.count ?? 0
    runtime.knownRepos = seed?.catalog.repos ?? [:]
    if snapshot.key != key {
      setCatalog(seed == nil ? "null" : scope.initialCatalog ?? "null", sessions: seed?.catalog.latestUserMessages ?? [:])
      snapshot.syncedAt = watch.syncedAt
    }
    snapshot.key = key
    snapshot.loading = true
    snapshot.connected = true
    snapshot.connection = CatalogConnection(state: watch.state, machines: watch.machines, syncedAt: watch.syncedAt)
    publish()
    readLocal(key: key, owner: watch.owner)
    runtime.start(workspace: selected.id,
                  owner: watch.owner, userId: account.user.id)
  }

  private func readLocal(key: String, owner: String) {
    LocalStore.queue.async {
      let raw = (try? LocalStore.shared.read(key)) ?? nil
      let saved = SavedCatalogDigest.decode(raw)
      DispatchQueue.main.async {
        MainActor.assumeIsolated { CatalogSession.shared.restore(owner: owner, raw: raw, saved: saved) }
      }
    }
  }

  private func restore(owner: String, raw: String?, saved: SavedCatalogDigest?) {
    guard let watch, watch.owner == owner, !watch.received, let raw, let saved else { return }
    runtime?.knownRepos = saved.catalog.repos
    watch.syncedAt = saved.syncedAt
    watch.machines = saved.catalog.machineIds.count
    let newer = saved.syncedAt.map { (snapshot.syncedAt ?? 0) > $0 } ?? false
    if snapshot.key != watch.key || !newer {
      setCatalog(raw, sessions: saved.catalog.latestUserMessages)
      snapshot.syncedAt = saved.syncedAt
      snapshot.loading = watch.state == "syncing"
      snapshot.connected = watch.state != "offline"
    }
    snapshot.connection = CatalogConnection(state: watch.state, machines: watch.machines, syncedAt: watch.syncedAt)
    publish()
  }

  private func receive(owner: String, state phase: String, catalog: String?) {
    guard let watch, watch.owner == owner else { return }
    var phase = phase
    if let catalog {
      if let digest = CatalogDigest.decode(catalog) {
        runtime?.knownRepos = digest.repos
        let syncedAt = Int(Date().timeIntervalSince1970 * 1000)
        watch.received = true
        watch.syncedAt = syncedAt
        watch.machines = digest.machineIds.count
        let saved = #"{"catalog":"# + catalog + #","syncedAt":\#(syncedAt)}"#
        setCatalog(saved, sessions: digest.latestUserMessages)
        persist(saved, watch: watch)
      } else {
        phase = "failed"
      }
    }
    if ["starting", "failed", "stopped", "background"].contains(phase) {
      snapshot.presence = CatalogPresence(workspaceId: watch.workspaceId)
    }
    let loading = ["starting", "syncing", "background"].contains(phase)
    let connected = !["offline", "failed", "stopped"].contains(phase)
    if !connected { watch.state = "offline" }
    else if loading { watch.state = "syncing" }
    else { watch.state = "live" }
    snapshot.loading = loading
    snapshot.connected = connected
    snapshot.syncedAt = watch.syncedAt ?? snapshot.syncedAt
    snapshot.connection = CatalogConnection(state: watch.state, machines: watch.machines, syncedAt: watch.syncedAt)
    publish()
  }

  private func receive(owner: String, presence: RuntimeContract.MachinePresence?) {
    guard let watch, watch.owner == owner else { return }
    snapshot.presence = CatalogPresence(workspaceId: watch.workspaceId, presence: presence ?? CatalogPresence.unknown)
    publish()
  }

  private func persist(_ value: String, watch: Watch) {
    let key = watch.key, generation = watch.generation, owner = watch.owner
    LocalStore.queue.async {
      do { try LocalStore.shared.write(key, value, generation: generation) } catch {
        DispatchQueue.main.async {
          MainActor.assumeIsolated { CatalogSession.shared.saveFailed(owner: owner) }
        }
      }
    }
  }

  private func saveFailed(owner: String) {
    guard let watch, watch.owner == owner, !watch.saveErrorShown else { return }
    watch.saveErrorShown = true
    toast("catalog.toast.localSaveFailed")
  }

  private func toast(_ key: String) {
    LodyToastOverlay.shared.show(message: String(localized: String.LocalizationValue(key), bundle: .lody), kind: "error")
  }

  private func setCatalog(_ value: String, sessions: [String: String]) {
    raw = value
    latestUserMessages = sessions
    snapshot.catalogRevision += 1
  }

  func outboxChanged() {
    publish()
  }

  private func publish() {
    let outbox = OutboxSession.shared
    snapshot.pendingSessions = outbox.pendingSessions(user: snapshot.userId, workspace: snapshot.workspaceId, excluding: latestUserMessages)
    guard Self.published.set(snapshot.json, catalog: raw) else { return }
    NotificationCenter.default.post(name: .lodyCatalogDidChange, object: nil)
    outbox.catalogChanged(snapshot, latestUserMessages: latestUserMessages)
  }
}

extension Notification.Name {
  static let lodyCatalogDidChange = Notification.Name("LodyCatalogDidChange")
}
