import LodyCore
import UIKit

@MainActor
class PromptShortcutsController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  private let service: PromptShortcutService
  private let fixed: SettingsWorkspace?
  private var workspace = SettingsWorkspace()
  private var items: [PromptShortcutEntry] = []
  private var loaded = false
  private var loading = true
  private var failed = false
  private var pulled = false
  private var loadedAt: Double?
  private var version = 0
  private var observer: NSObjectProtocol?

  init(workspace: SettingsWorkspace? = nil, service: @escaping PromptShortcutService = PromptShortcutsController.cloud) {
    fixed = workspace
    self.service = service
    super.init(nibName: nil, bundle: nil)
    title = PromptShortcutSections.text("title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in self?.event(name, body) }
    list.setRefreshEnabled(true)
    view.addSubview(list)
    if fixed == nil {
      observer = NotificationCenter.default.addObserver(forName: .lodyCatalogDidChange, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.sync() }
      }
    }
    sync(force: true)
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    renderHeader()
  }

  private func sync(force: Bool = false) {
    let next = fixed ?? .current
    guard force || next.key != workspace.key else { return }
    workspace = next
    items = []
    loaded = false
    loadedAt = nil
    refresh()
  }

  private func refresh() {
    version += 1
    let id = version
    loading = true
    failed = false
    render()
    Task { [weak self, service] in
      let result = try? await service(.list)
      guard let self, self.version == id else { return }
      if case .list(let value)? = result {
        self.items = value.entries
        self.loaded = true
        self.loadedAt = LodyRelativeTime.now()
      } else {
        self.failed = true
      }
      self.loading = false
      self.pulled = false
      self.render()
    }
  }

  private func render() {
    let state = LodyListState.make(
      title: String(localized: "settings.unavailable.shortcuts", bundle: .lody), hasData: loaded, loading: loading, failed: failed,
      syncedAt: loadedAt
    )
    list.setRefreshing(pulled && loading)
    list.setLoading(state.loading)
    list.setNotice(state.notice)
    list.setUnavailable(state.unavailable)
    list.setPlaceholder(loaded && items.isEmpty ? PromptShortcutSections.text("empty") : "")
    list.setSections(PromptShortcutSections.make(items, userId: workspace.userId))
    renderHeader()
  }

  private func renderHeader() {
    let add = LodyFormController.barButton(symbol: "plus", label: PromptShortcutSections.text("add")) { [weak self] in
      self?.edit(nil)
    }
    add.isEnabled = loaded && !loading && !failed
    parent?.navigationItem.rightBarButtonItems = [add]
  }

  private func event(_ name: String, _ body: [String: Any]) {
    switch name {
    case "rowPress":
      guard let entry = items.first(where: { $0.id == body["id"] as? String }) else { return }
      edit(entry)
    case "refresh":
      pulled = true
      refresh()
    case "noticeAction", "unavailableAction":
      refresh()
    default:
      break
    }
  }

  private func edit(_ entry: PromptShortcutEntry?) {
    let id = version
    Task { [weak self, service, workspace] in
      var value: PromptShortcutValue?
      if let entry {
        guard case .read(let read)? = try? await service(.read(entry)) else {
          LodyToastOverlay.shared.show(message: PromptShortcutSections.text("changed"), kind: "error")
          self?.refresh()
          return
        }
        value = read.shortcut
      }
      guard let self, self.version == id else { return }
      let editor = PromptShortcutEditorController(workspace: workspace, entry: entry, value: value, service: service)
      editor.saved = { [weak self] in self?.refresh() }
      LodyShell.shared.presentNative(editor, title: PromptShortcutSections.text("title"))
    }
  }

  /// A shortcut's body, read fresh for the composer: its index entry by id, then the body.
  static func body(id: String, service: PromptShortcutService = PromptShortcutsController.cloud) async throws -> RuntimeContract.PromptShortcut {
    guard case .list(let list) = try await service(.list), let entry = list.entries.first(where: { $0.id == id }) else {
      throw CocoaError(.fileNoSuchFile)
    }
    guard case .read(let read) = try await service(.read(entry)) else { throw CocoaError(.coderInvalidValue) }
    return read.shortcut
  }

  static func cloud(_ request: PromptShortcutRequest) async throws -> RuntimeContract.PromptShortcutsResult {
    guard let runtime = DataRuntime.current else {
      throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    return try await runtime.workspaceCall(RuntimeContract.Calls.PromptShortcuts.self) { workspaceId, userId in
      switch request {
      case .list:
        .list(.init(workspaceId: workspaceId, userId: userId))
      case .read(let entry):
        .read(.init(workspaceId: workspaceId, userId: userId, entry: entry))
      case .save(let entry, let value, let bodyDocId):
        .save(.init(workspaceId: workspaceId, userId: userId, entry: entry, value: value, bodyDocId: bodyDocId))
      }
    }
  }
}
