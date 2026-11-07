import UIKit

@MainActor
class AIUsageController: UIViewController {
  let list = LodyGroupedList(frame: .zero)
  private let service: UsageService
  private let fixedWorkspace: String?
  private var scope = ""
  private var workspace = ""
  private var range = UsageRange.day
  private var data: UsageSnapshot?
  private var busy = true
  private var failed = false
  private var pulled = false
  private var version = 0
  private var observer: NSObjectProtocol?

  init(workspace: String? = nil, service: @escaping UsageService = AIUsageController.cloud) {
    self.service = service
    fixedWorkspace = workspace
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "settings.aiUsage.title", bundle: .lody)
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
    list.setSegments(UsageRange.allCases.map { AIUsageFormat.text($0.rawValue) })
    view.addSubview(list)
    if fixedWorkspace == nil {
      observer = NotificationCenter.default.addObserver(forName: .lodyCatalogDidChange, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.syncScope() }
      }
    }
    syncScope()
  }

  private func syncScope() {
    let next: (key: String, workspace: String)
    if let fixedWorkspace {
      next = (fixedWorkspace, fixedWorkspace)
    } else {
      next = Self.selection()
    }
    guard next.key != scope else { return }
    scope = next.key
    workspace = next.workspace
    range = .day
    data = nil
    failed = false
    pulled = false
    read()
  }

  private func read() {
    version += 1
    guard !workspace.isEmpty else {
      busy = false
      pulled = false
      render()
      return
    }
    let id = version
    let request = UsageRequest(workspaceId: workspace, range: range)
    busy = true
    failed = false
    render()
    Task { [weak self, service] in
      let result: UsageSnapshot?
      do {
        let next = try await service(request)
        let scoped = next.workspaceId == request.workspaceId && next.range == request.range
        result = (next.summary != nil || next.timeline != nil) && scoped ? next : nil
      } catch {
        result = nil
      }
      guard let self, self.version == id else { return }
      if let result { self.data = result } else { self.failed = true }
      self.busy = false
      self.pulled = false
      self.render()
    }
  }

  private func render() {
    let value = data.flatMap { $0.range == range && $0.workspaceId == workspace ? $0 : nil }
    let partial = value?.errors.isEmpty == false ? AIUsageFormat.text("partialShort") : nil
    let state = LodyListState.make(
      title: String(localized: "settings.unavailable.usage", bundle: .lody), hasData: value != nil, loading: busy,
      failed: failed, partial: partial, syncedAt: value?.retrievedAt
    )
    list.setRefreshing(pulled && busy)
    list.setLoading(state.loading)
    list.setNotice(state.notice)
    list.setUnavailable(state.unavailable)
    list.setSelectedSegment(UsageRange.allCases.firstIndex(of: range) ?? 0)
    list.setSections(AIUsageSections.make(value))
  }

  private func event(_ name: String, _ body: [String: Any]) {
    switch name {
    case "segmentChange":
      guard let index = body["index"] as? Int, UsageRange.allCases.indices.contains(index) else { return }
      let next = UsageRange.allCases[index]
      guard next != range else { return }
      range = next
      read()
    case "refresh":
      pulled = true
      read()
    case "noticeAction", "unavailableAction":
      read()
    default:
      break
    }
  }

  private static func selection() -> (key: String, workspace: String) {
    struct Selection: Decodable {
      var userId = ""
      var workspaceId = ""
    }
    let selection = (try? JSONDecoder().decode(Selection.self, from: Data(CatalogSession.published.json.utf8))) ?? Selection()
    guard !selection.userId.isEmpty, !selection.workspaceId.isEmpty else { return ("", "") }
    return ("\(selection.userId):\(selection.workspaceId)", selection.workspaceId)
  }

  static func cloud(_ request: UsageRequest) async throws -> UsageSnapshot {
    let payload = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
    let raw = try await WorkspaceSettingsCloud.run(payload)
    let snapshot = try JSONDecoder().decode(UsageSnapshot.self, from: Data(raw.utf8))
    guard snapshot.valid, snapshot.workspaceId == request.workspaceId, snapshot.range == request.range else {
      throw CocoaError(.coderInvalidValue)
    }
    return snapshot
  }
}
