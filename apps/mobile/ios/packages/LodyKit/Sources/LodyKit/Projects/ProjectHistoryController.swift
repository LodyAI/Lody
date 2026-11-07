import LodyCore
import UIKit

@MainActor
struct ProjectHistoryService {
  var call: (HistoryRequest) async throws -> HistoryResponse
  var cancel: () -> Void

  static func live(workspaceId: String) -> ProjectHistoryService {
    let browserId = LocalProjects.browserId("history")
    return ProjectHistoryService(
      call: { request in
        do { return try await LocalProjects.history(workspaceId: workspaceId, browserId: browserId, request) } catch {
          switch request {
          case .import, .resolve: throw SettingsError(ProjectHistorySections.text("writeFailed"))
          default: throw SettingsError(ProjectHistorySections.text("loadFailed"))
          }
        }
      },
      cancel: { LocalProjects.cancel(workspaceId: workspaceId, browserId: browserId) }
    )
  }
}

@MainActor
class ProjectHistoryController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  let scope: SettingsActor
  private let makeService: (String) -> ProjectHistoryService
  private var service: ProjectHistoryService
  private var state: ProjectHistoryState
  private var locked = false
  private var alive = true
  private var generation = 0
  private lazy var refreshItem = LodyFormController.barButton(symbol: "arrow.clockwise", label: text("sync")) { [weak self] in
    self?.load()
  }
  private lazy var selectItem = UIBarButtonItem(primaryAction: UIAction(title: text("selectAll")) { [weak self] _ in
    self?.toggleAll()
  })
  private lazy var importItem: UIBarButtonItem = {
    let item = UIBarButtonItem(primaryAction: UIAction(title: text("import")) { [weak self] _ in self?.importSelected() })
    item.style = .prominent
    item.tintColor = .lodyAccent
    return item
  }()

  init(
    scope: SettingsActor, mode: ProjectHistoryMode = .projects,
    service makeService: @escaping (String) -> ProjectHistoryService = { .live(workspaceId: $0) }
  ) {
    self.scope = scope
    self.makeService = makeService
    service = makeService(scope.workspaceId)
    state = ProjectHistoryState(mode: mode)
    super.init(nibName: nil, bundle: nil)
    title = text("title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    scope.watch(self) { [weak self] in self?.scopeDidChange() }
    load()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    parent?.navigationItem.rightBarButtonItems = [refreshItem]
    if state.target != nil {
      parent?.setToolbarItems([selectItem, .flexibleSpace(), importItem], animated: false)
    }
    render()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    guard SettingsPage.leaving(self) else { return }
    alive = false
    service.cancel()
  }

  func scopeDidChange() {
    guard case .projects = state.mode else { return SettingsPage.pop(self) }
    service.cancel()
    generation += 1
    locked = false
    service = makeService(scope.workspaceId)
    state = ProjectHistoryState(mode: .projects)
    load()
  }

  private func run(_ kind: ProjectHistoryOperation, _ work: @escaping () async throws -> Void) {
    guard !locked, alive else { return }
    locked = true
    let id = generation
    state.operation = kind
    state.busy = true
    state.error = ""
    state.notice = ""
    render()
    Task {
      do { try await work() } catch {
        if alive, generation == id { state.error = (error as? SettingsError)?.description ?? text("loadFailed") }
      }
      guard generation == id else { return }
      locked = false
      if alive { state.busy = false }
      render()
    }
  }

  private func current(_ id: Int) -> Bool { alive && generation == id }

  private func load() {
    let id = generation
    run(.load) { [self] in
      let request: HistoryRequest = state.target.map { HistoryRequest.sync(.init(target: $0)) } ?? .targets(.init())
      let response = try await service.call(request)
      guard current(id) else { return }
      switch response {
      case .targets(let targets): state.targets = targets
      case .result(let result):
        state.result = result
        state.selected = []
      }
    }
  }

  private func importSelected() {
    guard let target = state.target else { return }
    let id = generation
    run(.import) { [self] in
      let ids = state.selected
      var failures: [RuntimeContract.LocalProjectsResultHistoryFailuresItem] = []
      for start in stride(from: 0, to: ids.count, by: 5) {
        guard current(id) else { return }
        let batch = Array(ids[start..<min(start + 5, ids.count)])
        let response = try await service.call(.import(.init(target: target, acpSessionIds: batch)))
        guard current(id) else { return }
        guard case .result(let result) = response else { throw SettingsError(text("writeFailed")) }
        state.result = result
        failures += result.failures ?? []
        let failed = Set(failures.map(\.acpSessionId))
        state.selected = state.selected.filter { !batch.contains($0) || failed.contains($0) }
        state.notice = String.localizedStringWithFormat(String(localized: "settings.history.progress", bundle: .lody), String(describing: min(start + 5, ids.count)), String(describing: ids.count))
        render()
      }
      if !failures.isEmpty {
        state.error = String.localizedStringWithFormat(String(localized: "settings.history.partialFailure", bundle: .lody), failures.count)
      }
    }
  }

  private func resolve(_ acpSessionId: String) {
    guard let target = state.target, !locked,
          let sessionId = state.result?.sessions.first(where: { $0.acpSessionId == acpSessionId })?.importedSessionId else { return }
    SettingsPage.confirm(
      from: self, title: text("replaceTitle"), message: text("replaceHint"), action: text("replace"), destructive: true
    ) { [weak self] in
      guard let self else { return }
      let id = generation
      run(.resolve) { [self] in
        let response = try await service.call(.resolve(.init(target: target, sessionId: sessionId, acpSessionId: acpSessionId)))
        guard current(id) else { return }
        guard case .result(let result) = response else { throw SettingsError(text("writeFailed")) }
        state.result = result
        state.notice = text("resolved")
      }
    }
  }

  private func toggleAll() {
    guard !locked else { return }
    state.selected = state.allSelected ? [] : state.available
    render()
  }

  private func event(_ name: String, _ body: [String: Any]) {
    if name == "refresh" { return load() }
    guard name == "rowPress", let id = body["id"] as? String, !state.busy, !locked else { return }
    if let project = state.targets.first(where: { ProjectHistorySections.projectId($0) == id }) {
      return push(.agents(project), title: project.projectName)
    }
    if let target = state.targets.first(where: { ProjectHistorySections.targetId($0) == id }) {
      return push(.sessions(target), title: RemoteSettingsSections.agentName(target.provider.agentType))
    }
    guard let session = state.result?.sessions.first(where: { ProjectHistorySections.sessionId($0.acpSessionId) == id }),
          session.status != .imported else { return }
    if session.status == .syncConflict { return resolve(session.acpSessionId) }
    if let index = state.selected.firstIndex(of: session.acpSessionId) {
      state.selected.remove(at: index)
    } else {
      state.selected.append(session.acpSessionId)
    }
    render()
  }

  private func push(_ mode: ProjectHistoryMode, title: String) {
    LodyShell.shared.pushNative(ProjectHistoryController(scope: scope, mode: mode, service: makeService), title: title, from: self)
  }

  private func render() {
    refreshItem.isEnabled = !state.busy
    selectItem.title = text(state.allSelected ? "deselectAll" : "selectAll")
    selectItem.isEnabled = !state.busy && !state.available.isEmpty
    importItem.title = String.localizedStringWithFormat(String(localized: "settings.history.import", bundle: .lody), String(describing: state.selected.count))
    importItem.isEnabled = !state.busy && !state.selected.isEmpty
    list.setRefreshing(state.busy && state.operation == .load)
    list.setSections(ProjectHistorySections.make(state))
  }

  private func text(_ key: String) -> String { ProjectHistorySections.text(key) }
}
