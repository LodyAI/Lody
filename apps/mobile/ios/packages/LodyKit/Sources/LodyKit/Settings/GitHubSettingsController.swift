import UIKit

@MainActor
class GitHubSettingsController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  private let service: GitHubSettingsService
  private let fixedWorkspace: String?
  private let changed: @MainActor () -> Void
  private let open: @MainActor (URL) async -> Void
  private var scope = ""
  private var workspace = ""
  private var userId = ""
  private var value: GitHubSettings?
  private var busy = true
  private var failed = false
  private var unconfirmed = false
  private var pulled = false
  private var writing = false
  private var opening = false
  private var loadedAt: Double?
  private var version = 0
  private var observers: [NSObjectProtocol] = []
  private let search = LodyNavigationSearch()
  private var query = ""
  /// The switch the user just flipped, shown at its new position until the write reads back;
  /// a failed or unconfirmed write drops it, so the row returns to the last read value.
  private var pending: (id: String, enabled: Bool)?
  /// The account/workspace-scoped last complete read, shown at once while a live read refreshes
  /// it; previews with a fixed workspace keep none. The list rarely changes, so its switches work
  /// straight away: every write re-reads the role and repository list natively and reads back.
  private var store: SettingsSnapshotStore<GitHubSettings>? {
    guard fixedWorkspace == nil else { return nil }
    return SettingsSnapshotStore(kind: "github", userId: userId, workspaceId: workspace)
  }

  init(
    workspace: String? = nil,
    service: @escaping GitHubSettingsService = GitHubSettingsController.cloud,
    changed: @escaping @MainActor () -> Void = { CatalogSession.shared.refresh() },
    open: @escaping @MainActor (URL) async -> Void = { _ = await UIApplication.shared.open($0) }
  ) {
    fixedWorkspace = workspace
    self.service = service
    self.changed = changed
    self.open = open
    super.init(nibName: nil, bundle: nil)
    title = "GitHub"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    view.addSubview(list)
    search.configure(LodyNavigationSearch.Config(
      placeholder: GitHubSettingsSections.text("search"), placement: "stacked", hideWhenScrolling: false,
      autoCapitalize: "none", obscureBackground: false, hideNavigationBar: false
    ))
    search.emit = { [weak self] event, text in
      guard let self, event == "change" || event == "cancel" else { return }
      let next = event == "cancel" ? "" : text
      guard next != query else { return }
      query = next
      render()
    }
    if fixedWorkspace == nil {
      observers.append(NotificationCenter.default.addObserver(forName: .lodyCatalogDidChange, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.syncScope() }
      })
    }
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.returned() }
    })
    syncScope()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    // Hosted pages write their bar items, including search, to the hosting page's item.
    guard let item = parent?.navigationItem else { return }
    LodyNavigationHeader.of(item).search = search
  }

  private func syncScope() {
    let current = SettingsWorkspace.current
    let next = fixedWorkspace ?? current.workspaceId
    let key = fixedWorkspace ?? current.key
    guard key != scope else { return }
    scope = key
    workspace = next
    userId = fixedWorkspace == nil ? current.userId : ""
    value = nil
    pending = nil
    failed = false
    unconfirmed = false
    pulled = false
    loadedAt = nil
    version += 1
    let id = version, store = store
    Task { [weak self] in
      let cached = await store?.read()
      guard let self, self.version == id else { return }
      if let cached, cached.valid, self.value == nil { self.value = cached }
      self.read()
    }
  }

  private func returned() {
    guard opening else { return }
    opening = false
    read()
    changed()
  }

  private func read() {
    guard !writing else { return }
    version += 1
    guard !scope.isEmpty else {
      busy = false
      pulled = false
      return render()
    }
    let id = version
    busy = true
    failed = false
    render()
    Task { [weak self, service, workspace] in
      let result = try? await service(GitHubSettingsRequest(workspaceId: workspace, action: "list"))
      guard let self, self.version == id else { return }
      if case .settings(let next) = result {
        self.accept(next)
        self.unconfirmed = false
      } else {
        self.failed = true
      }
      self.busy = false
      self.pulled = false
      self.render()
    }
  }

  /// Only a complete read is remembered; a partial one would lock the cached page on reopen.
  private func accept(_ next: GitHubSettings) {
    value = next
    loadedAt = LodyRelativeTime.now()
    if next.errors.isEmpty { store?.write(next) }
  }

  /// A write may start while a background refresh is still reading: it supersedes that read
  /// (its result is dropped) and its own read back becomes the page.
  private func perform(_ request: GitHubSettingsRequest, showing shown: (id: String, enabled: Bool)? = nil) {
    guard !writing else { return }
    pending = shown
    writing = true
    busy = true
    failed = false
    version += 1
    let id = version
    render()
    Task { [weak self, service] in
      let result: GitHubSettingsResult?
      do { result = try await service(request) } catch { result = nil }
      guard let self else { return }
      if self.version == id {
        switch result {
        case .url(let url):
          self.opening = true
          await self.open(url)
        case .settings(let next):
          self.accept(next)
          self.changed()
        case nil:
          self.unconfirmed = true
        }
      }
      self.writing = false
      self.pending = nil
      guard self.version == id else { return }
      self.busy = false
      self.render()
    }
  }

  private var blocked: Bool { failed || unconfirmed || value?.errors.isEmpty == false }

  private func render() {
    let state = LodyListState.make(
      title: String(localized: "settings.unavailable.github", bundle: .lody), hasData: value != nil, loading: busy, failed: failed,
      unconfirmed: unconfirmed, partial: value?.errors.isEmpty == false ? GitHubSettingsSections.text("partial") : nil,
      syncedAt: loadedAt
    )
    list.setRefreshing(pulled && busy)
    list.setLoading(state.loading)
    list.setNotice(state.notice)
    list.setUnavailable(state.unavailable)
    list.setSections(shown.map { GitHubSettingsSections.make($0, enabled: !writing && !blocked, query: query) } ?? [])
  }

  /// The last read value with the in-flight switch applied.
  private var shown: GitHubSettings? {
    guard var next = value, let pending else { return value }
    if pending.id == "preference" {
      next.personal?.enabled = pending.enabled
    } else if pending.id.hasPrefix("repo:"), let index = next.repositories?.firstIndex(where: { "repo:" + $0.repoFullName == pending.id }) {
      next.repositories?[index].enabled = pending.enabled
    }
    return next
  }

  private func event(_ name: String, _ body: [String: Any]) {
    let id = body["id"] as? String ?? ""
    switch name {
    case "refresh":
      pulled = true
      read()
    case "noticeAction", "unavailableAction":
      read()
    case "rowPress" where id == "install" && value?.canManage == true:
      perform(GitHubSettingsRequest(workspaceId: workspace, action: "install"))
    case "rowToggle":
      guard let enabled = body["value"] as? Bool, !blocked else { return }
      let repo = id.hasPrefix("repo:") ? String(id.dropFirst(5)) : nil
      if id == "preference", let personal = value?.personal, personal.enabled != enabled,
         !enabled || personal.authorization.state == .authorized {
        perform(GitHubSettingsRequest(workspaceId: workspace, action: "preference", enabled: enabled), showing: (id, enabled))
      } else if let repo, value?.canManage == true,
                value?.repositories?.contains(where: { $0.repoFullName == repo && $0.enabled != enabled }) == true {
        perform(GitHubSettingsRequest(workspaceId: workspace, action: "repository", repoFullName: repo, enabled: enabled), showing: (id, enabled))
      }
    default:
      break
    }
  }

  static func cloud(_ request: GitHubSettingsRequest) async throws -> GitHubSettingsResult {
    let payload = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
    let data = Data(try await WorkspaceSettingsCloud.run(payload).utf8)
    if request.action == "install" {
      struct Install: Decodable { var url: String }
      guard let url = GitHubSettingsSections.installURL(try JSONDecoder().decode(Install.self, from: data).url) else {
        throw CocoaError(.coderInvalidValue)
      }
      return .url(url)
    }
    let settings = try JSONDecoder().decode(GitHubSettings.self, from: data)
    guard settings.valid else { throw CocoaError(.coderInvalidValue) }
    return .settings(settings)
  }
}
