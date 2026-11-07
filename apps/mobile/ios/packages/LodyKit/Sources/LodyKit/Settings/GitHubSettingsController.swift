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

  private func syncScope() {
    let current = SettingsWorkspace.current
    let next = fixedWorkspace ?? current.workspaceId
    let key = fixedWorkspace ?? current.key
    guard key != scope else { return }
    scope = key
    workspace = next
    value = nil
    failed = false
    unconfirmed = false
    pulled = false
    loadedAt = nil
    read()
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
        self.value = next
        self.unconfirmed = false
        self.loadedAt = LodyRelativeTime.now()
      } else {
        self.failed = true
      }
      self.busy = false
      self.pulled = false
      self.render()
    }
  }

  private func perform(_ request: GitHubSettingsRequest) {
    guard !writing, !busy else { return }
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
          self.value = next
          self.changed()
        case nil:
          self.unconfirmed = true
        }
      }
      self.writing = false
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
    list.setSections(value.map { GitHubSettingsSections.make($0, enabled: !busy && !blocked) } ?? [])
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
    case "rowAction":
      guard let action = body["actionId"] as? String, ["enabled", "disabled"].contains(action), !blocked else { return }
      let enabled = action == "enabled"
      let repo = id.hasPrefix("repo:") ? String(id.dropFirst(5)) : nil
      if id == "preference", value?.personal?.enabled != enabled {
        perform(GitHubSettingsRequest(workspaceId: workspace, action: "preference", enabled: enabled))
      } else if let repo, value?.canManage == true,
                value?.repositories?.contains(where: { $0.repoFullName == repo && $0.enabled != enabled }) == true {
        perform(GitHubSettingsRequest(workspaceId: workspace, action: "repository", repoFullName: repo, enabled: enabled))
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
