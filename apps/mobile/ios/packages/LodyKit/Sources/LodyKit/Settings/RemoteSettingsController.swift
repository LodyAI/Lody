import LodyCore
import UIKit

struct RemoteSettingsContext {
  var connected = true
  var presence = SettingsMachinePresence.unknown
  var agentUsage: [String: AgentUsage] = [:]

  @MainActor static func current() -> RemoteSettingsContext {
    struct Saved: Decodable {
      struct Catalog: Decodable { var agentUsage: [String: AgentUsage]? }
      var catalog: Catalog
    }
    let workspace = SettingsWorkspace.current
    let raw = Data(CatalogSession.published.raw.utf8)
    let usage = (try? JSONDecoder().decode(Saved.self, from: raw))?.catalog.agentUsage ?? [:]
    return RemoteSettingsContext(connected: workspace.connected, presence: workspace.presence, agentUsage: usage)
  }
}

struct RemoteSettingsCache {
  var read: @MainActor (String) async -> SavedRemoteSettings?
  var write: @MainActor (String, SavedRemoteSettings) -> Void

  static func local(userId: String, workspaceId: String) -> RemoteSettingsCache {
    RemoteSettingsCache(
      read: { kind in
        let key = SavedRemoteSettings.key(userId: userId, workspaceId: workspaceId, kind: kind)
        let raw: String? = await withCheckedContinuation { done in
          LocalStore.queue.async { done.resume(returning: (try? LocalStore.shared.read(key)) ?? nil) }
        }
        return SavedRemoteSettings.parse(raw, kind: kind)
      },
      write: { kind, saved in
        let key = SavedRemoteSettings.key(userId: userId, workspaceId: workspaceId, kind: kind)
        let value = saved.json, generation = LocalStore.shared.generation
        LocalStore.queue.async { try? LocalStore.shared.write(key, value, generation: generation) }
      }
    )
  }

  static func memory() -> RemoteSettingsCache {
    final class Box: @unchecked Sendable { var values: [String: SavedRemoteSettings] = [:] }
    let box = Box()
    return RemoteSettingsCache(read: { box.values[$0] }, write: { box.values[$0] = $1 })
  }
}

@MainActor
class RemoteSettingsController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  let kind: String
  let scope: SettingsActor
  private let service: RemoteSettingsService
  private let fixedCache: RemoteSettingsCache?
  private let contextSource: @MainActor () -> RemoteSettingsContext
  private let refreshUsage: @MainActor () -> Void
  private var cache: RemoteSettingsCache?
  private var context = RemoteSettingsContext()
  private var workspace = ""
  private var items: [RemoteSetting] = []
  private var syncedAt: Double?
  private var loading = true
  private var error = ""
  private var pulled = false
  private var requestId = 0
  private var observer: NSObjectProtocol?

  init(
    kind: String, scope: SettingsActor, service: @escaping RemoteSettingsService = RemoteSettingsController.cloud,
    cache: RemoteSettingsCache? = nil, context: @escaping @MainActor () -> RemoteSettingsContext = { .current() },
    refreshUsage: @escaping @MainActor () -> Void = { CatalogSession.shared.refresh() }
  ) {
    self.kind = kind
    self.scope = scope
    self.service = service
    fixedCache = cache
    contextSource = context
    self.refreshUsage = refreshUsage
    super.init(nibName: nil, bundle: nil)
    title = RemoteSettingsSections.remote(kind)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    observer = NotificationCenter.default.addObserver(forName: .lodyCatalogDidChange, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.contextDidChange() }
    }
    scope.watch(self) { [weak self] in self?.reset() }
    reset()
  }

  func contextDidChange() {
    context = contextSource()
    render()
  }

  private var snapshot: SavedRemoteSettings? {
    guard !items.isEmpty, let syncedAt else { return nil }
    return SavedRemoteSettings(items: items, syncedAt: syncedAt)
  }

  private func reset() {
    workspace = scope.valid ? scope.workspaceId : ""
    cache = fixedCache ?? (scope.valid ? .local(userId: scope.userId, workspaceId: workspace) : nil)
    context = contextSource()
    items = []
    syncedAt = nil
    refresh(reuse: nil)
  }

  private func apply(_ saved: SavedRemoteSettings) {
    items = saved.items
    syncedAt = saved.syncedAt
  }

  private func refresh(reuse: SavedRemoteSettings?) {
    requestId += 1
    let id = requestId
    guard !workspace.isEmpty else {
      loading = false
      pulled = false
      return render()
    }
    loading = true
    error = ""
    render()
    let request = RemoteSettingsRequest(workspaceId: workspace, kind: kind)
    Task { [weak self, service, cache, kind] in
      if reuse == nil, let saved = await cache?.read(kind) {
        guard let self, self.requestId == id else { return }
        self.apply(saved)
        self.render()
      }
      let result: Result<[RemoteSetting], Error>
      do { result = .success(try await service(request)) } catch { result = .failure(error) }
      guard let self, self.requestId == id else { return }
      switch result {
      case .success(let items):
        let live = SavedRemoteSettings(items: items, syncedAt: LodyRelativeTime.now())
        cache?.write(kind, live)
        self.apply(live)
        self.error = ""
      case .failure(let failure):
        self.error = (failure as? SettingsError)?.description ?? RemoteSettingsSections.remote("loadFailed")
      }
      self.loading = false
      self.pulled = false
      self.render()
    }
  }

  private func render() {
    let state = LodyListState.make(
      title: String(localized: String.LocalizationValue("settings.unavailable." + kind), bundle: .lody), hasData: !items.isEmpty, loading: loading,
      failed: !error.isEmpty, offline: !context.connected, syncedAt: syncedAt
    )
    list.setRefreshing(pulled && loading)
    SettingsPage.apply(state, to: list)
    list.setPlaceholder(!loading && error.isEmpty && items.isEmpty ? RemoteSettingsSections.remote("empty") : "")
    list.setSections(RemoteSettingsSections.make(
      kind: kind, items: items, failed: !error.isEmpty, connected: context.connected, agentUsage: context.agentUsage,
      presence: context.presence
    ))
  }

  private func event(_ name: String, _ body: [String: Any]) {
    switch name {
    case "refresh":
      pulled = true
      refreshUsage()
      context = contextSource()
      refresh(reuse: snapshot)
    case "noticeAction", "unavailableAction":
      refresh(reuse: snapshot)
    case "rowPress":
      guard let id = body["id"] as? String, let item = items.first(where: { $0.settingId == id }), !item.locked else { return }
      let editor = RemoteSettingEditorController(item: item, workspaceId: workspace, service: service)
      editor.saved = { [weak self] in
        guard let self else { return }
        self.refresh(reuse: self.snapshot)
      }
      let machine = kind == "machine"
      LodyShell.shared.presentNative(
        editor, title: RemoteSettingsSections.remote("edit\(kind)"), detents: machine ? [0.5, 1] : [1], grabber: machine
      )
    default:
      break
    }
  }

  static func cloud(_ request: RemoteSettingsRequest) async throws -> [RemoteSetting] {
    do {
      let items = try await DataRuntime.settingsCall(
        RuntimeContract.Calls.RemoteSettings.self, request, as: [RemoteSetting].self
      ) { $0.settings }
      guard items.allSatisfy({ $0.kind == request.kind }) else { throw SettingsError("invalid_setting") }
      return items
    } catch {
      throw SettingsError(RemoteSettingsFailure.message(error, request: request))
    }
  }
}
