import LodyCore
import UIKit

@MainActor
class PublishedSharesController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  let scope: SettingsActor
  private let service: PublishedSharesService
  private var workspace = ""
  private var actor = ""
  private var snapshot: PublishedSharePage?
  private var history: [String?] = [nil]
  private var retry: [String?] = [nil]
  private var busy = true
  private var failed = false
  private var failure = ""
  private var syncedAt: Double?
  private var generation = 0

  init(scope: SettingsActor, service: @escaping PublishedSharesService = PublishedSharesController.cloud) {
    self.scope = scope
    self.service = service
    super.init(nibName: nil, bundle: nil)
    title = PublishedSharesSections.text("title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    scope.watch(self) { [weak self] in
      guard let self else { return }
      self.generation += 1
      self.scopeDidChange()
    }
    reset()
  }

  func scopeDidChange() { reset() }

  private func reset() {
    workspace = scope.valid ? scope.workspaceId : ""
    actor = scope.userId
    snapshot = nil
    history = [nil]
    failure = ""
    syncedAt = nil
    load([nil])
  }

  private func load(_ cursors: [String?]) {
    generation += 1
    guard !workspace.isEmpty else {
      busy = false
      return render()
    }
    let version = generation
    retry = cursors
    busy = true
    failed = false
    render()
    Task { [weak self, service, workspace, actor] in
      let result: Result<PublishedSharePage, Error>
      do {
        let page = try await service(.list(workspace, cursor: cursors.last ?? nil))
        if page.userId != actor { throw SettingsError("shares_scope_changed") }
        if !page.isDone && cursors.contains(page.continueCursor) { throw SettingsError("shares_cursor_stalled") }
        result = .success(page)
      } catch {
        result = .failure(error)
      }
      guard let self, version == self.generation else { return }
      switch result {
      case .success(let page):
        self.snapshot = page
        self.history = cursors
        self.syncedAt = LodyRelativeTime.now()
        self.failure = ""
      case .failure(let error):
        self.failed = true
        self.failure = PublishedSharesSections.errorText(error)
        if PublishedSharesSections.message(error).contains("shares_forbidden") { self.snapshot = nil }
      }
      self.busy = false
      self.render()
    }
  }

  private func render() {
    let state = LodyListState.make(
      title: PublishedSharesSections.text("unavailable"), hasData: snapshot != nil, loading: busy, failed: failed,
      syncedAt: syncedAt
    )
    list.setLoading(state.loading)
    if var unavailable = state.unavailable, !failure.isEmpty {
      unavailable.message = failure
      list.setUnavailable(unavailable)
    } else {
      list.setUnavailable(state.unavailable)
    }
    if var notice = state.notice, !failure.isEmpty {
      let pageFailed = snapshot != nil && (retry.last ?? nil) != (history.last ?? nil)
      notice.text = pageFailed ? PublishedSharesSections.text("pageFailed") : failure
      list.setNotice(notice)
    } else {
      list.setNotice(state.notice)
    }
    list.setRefreshing(busy && snapshot != nil)
    list.setSections(PublishedSharesSections.list(snapshot, pages: history.count, busy: busy, failed: failed))
  }

  private func event(_ name: String, _ body: [String: Any]) {
    switch name {
    case "noticeAction", "unavailableAction":
      load(retry)
    case "refresh":
      load(history)
    case "rowPress":
      guard let id = body["id"] as? String else { return }
      press(id)
    default:
      break
    }
  }

  private func press(_ id: String) {
    guard !busy, let snapshot else { return }
    if id == "shares-next", !snapshot.isDone { load(history + [snapshot.continueCursor]) }
    if id == "shares-previous", history.count > 1 { load(Array(history.dropLast())) }
    guard let entry = snapshot.page.first(where: { "share:\($0.shareId)" == id }), !failed else { return }
    let version = generation
    let detail = PublishedShareDetailController(scope: scope, workspaceId: workspace, entry: entry, service: service) {
      [weak self] in
      guard let self, version == self.generation else { return }
      self.load(self.history)
    }
    LodyShell.shared.pushNative(detail, title: PublishedSharesSections.text("details"), from: self)
  }

  static func cloud(_ request: PublishedSharesRequest) async throws -> PublishedSharePage {
    let page = try await DataRuntime.settingsCall(
      RuntimeContract.Calls.PublishedShares.self, request, as: PublishedSharePage.self
    ) { result -> any Encodable in
      switch result {
      case .page(let value): return value
      case .failed(let value):
        throw SettingsError(PublishedSharesSections.knownErrors.contains(value.error) ? value.error : "shares_invalid")
      }
    }
    let single = request.action == "list" || (page.page.count == 1 && page.page.first?.shareId == request.shareId)
    guard page.valid, page.workspaceId == request.workspaceId, single else { throw SettingsError("shares_scope_changed") }
    return page
  }
}
