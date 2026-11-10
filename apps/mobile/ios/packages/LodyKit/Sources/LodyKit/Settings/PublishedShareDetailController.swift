import UIKit

@MainActor
final class PublishedShareDetailController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private let scope: SettingsActor
  private let expected: String
  private let actor: String
  private let workspaceId: String
  private let initial: PublishedShare
  private let service: PublishedSharesService
  private let closed: @MainActor () -> Void
  private var entry: PublishedShare?
  private var busy = true
  private var guarding = false
  private var failure = ""
  private var notice = ""
  private var blocked = false
  private var finished = false

  init(
    scope: SettingsActor, workspaceId: String, entry: PublishedShare, service: @escaping PublishedSharesService,
    closed: @escaping @MainActor () -> Void
  ) {
    self.scope = scope
    expected = scope.key
    actor = scope.userId
    self.workspaceId = workspaceId
    initial = entry
    self.service = service
    self.closed = closed
    super.init(nibName: nil, bundle: nil)
    title = PublishedSharesSections.text("details")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private var current: Bool { scope.key == expected }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    list.setPlaceholder("")
    scope.watch(self) { [weak self] in
      guard let self, !self.current else { return }
      SettingsPage.pop(self)
    }
    run("detail")
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    guard !finished, SettingsPage.leaving(self) || !current else { return }
    finished = true
    closed()
  }

  private func run(_ action: String) {
    guard !guarding, current, action == "detail" || !blocked else { return }
    guarding = true
    busy = true
    notice = ""
    render()
    let request = PublishedSharesRequest.entry(workspaceId, action, initial, revision: entry?.revision)
    Task { [weak self, service, actor] in
      let result: Result<PublishedShare, Error>
      do {
        let page = try await service(request)
        guard page.userId == actor, let first = page.page.first else { throw SettingsError("shares_scope_changed") }
        result = .success(first)
      } catch {
        result = .failure(error)
      }
      guard let self else { return }
      self.guarding = false
      guard self.current else { return }
      switch result {
      case .success(let next):
        self.entry = next
        self.failure = ""
        self.blocked = false
        if action == "copy" { self.notice = PublishedSharesSections.text("copied") }
        if action == "revoke" { self.notice = PublishedSharesSections.text("revoked") }
      case .failure(let error):
        let described = PublishedSharesSections.message(error)
        var message = PublishedSharesSections.errorText(error)
        if action == "revoke" && !described.contains("shares_") { message = PublishedSharesSections.text("error.write_unknown") }
        self.failure = message
        self.blocked = true
        if described.contains("shares_forbidden") { self.entry = nil }
      }
      self.busy = false
      self.render()
    }
  }

  private func render() {
    guard current else {
      list.setSections([])
      return
    }
    var unavailable: LodyListUnavailable?
    if !busy && entry == nil {
      var value = LodyListUnavailable()
      value.title = PublishedSharesSections.text("unavailable")
      value.message = failure.isEmpty ? PublishedSharesSections.text("error.unavailable") : failure
      value.symbol = "wifi.exclamationmark"
      value.actionTitle = String(localized: "settings.state.tryAgain", bundle: .lody)
      unavailable = value
    }
    var feedback: LodyListNotice?
    if !failure.isEmpty && unavailable == nil {
      var value = LodyListNotice()
      value.symbol = "exclamationmark.triangle"
      value.text = failure
      value.tint = "warning"
      value.actionLabel = String(localized: "settings.state.refresh", bundle: .lody)
      value.actionSymbol = "arrow.clockwise"
      feedback = value
    } else if !notice.isEmpty {
      var value = LodyListNotice()
      value.symbol = "checkmark.circle"
      value.text = notice
      feedback = value
    }
    list.setLoading(busy && entry == nil)
    list.setUnavailable(unavailable)
    list.setNotice(feedback)
    list.setRefreshing(busy && entry != nil)
    list.setSections(entry.map { PublishedSharesSections.detail($0, actor: actor, busy: busy, blocked: blocked) } ?? [])
  }

  private func event(_ name: String, _ body: [String: Any]) {
    switch name {
    case "refresh", "noticeAction", "unavailableAction":
      run("detail")
    case "rowPress":
      guard entry != nil, !busy, !blocked else { return }
      switch body["id"] as? String {
      case "share-copy": run("copy")
      case "share-open": run("open")
      case "share-revoke":
        SettingsPage.confirm(
          from: self, title: PublishedSharesSections.text("revoke"), message: PublishedSharesSections.text("revokeConfirm"),
          action: PublishedSharesSections.text("revoke"), destructive: true
        ) { [weak self] in self?.run("revoke") }
      default: break
      }
    default:
      break
    }
  }
}
