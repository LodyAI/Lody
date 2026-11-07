import LodyCore
import UIKit

@MainActor
enum NativeDebug {
  static func start(in window: UIWindow) {
    precondition(LodyUIVerify.enabled)
    if LodyUIVerify.home {
      do { try NativeHomeFixture.prepare() }
      catch { preconditionFailure("Invalid offline fixture: \(error)") }
    }
    let root: UIViewController
    if LodyUIVerify.has("--ui-review-list") {
      root = ChatListPreviewController()
    } else if LodyUIVerify.has("--ui-review-mentions") {
      root = SessionPreviewController(scenario: "mentions")
    } else if let review = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--ui-review-bar=") }) {
      root = SessionPreviewController(scenario: "bar-" + String(review.dropFirst("--ui-review-bar=".count)))
    } else {
      root = LodyUIVerify.has("--ui-verify-home") ? HomeController() : NativeDebugController()
    }
    LodyShell.shared.start(in: window, content: root, title: root is NativeDebugController ? "Debug" : (LodyUIVerify.has("--ui-review-bar=tabs") ? "Tabs" : ""))
    let ready = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    ready.isAccessibilityElement = true
    ready.accessibilityIdentifier = "ui-verify-ready"
    ready.accessibilityLabel = "Offline native fixtures ready"
    window.addSubview(ready)
  }

  static func open(_ params: [String: String]) {
    guard LodyUIVerify.enabled || _isDebugAssertConfiguration() else { return }
    guard let scenario = params["verifyCase"] else {
      LodyShell.shared.pushRootNative(NativeDebugController(), title: "Debug")
      return
    }
    if scenario == "home-native-alert" {
      let alert = UIAlertController(title: "Layout verification", message: nil, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: "OK", style: .default))
      LodyShell.shared.presenter?.present(alert, animated: true)
      return
    }
    if scenario == "home-file-preview" {
      guard let home = HomeController.current,
            let content = LodyNativePages.make("file-diff-preview", params: "{}") else {
        preconditionFailure("Home file preview requires an open offline Home session")
      }
      LodyShell.shared.presentDetail(content, title: String(localized: "diff.title", bundle: .lody), from: home, push: true, detents: [1])
      return
    }
    let content: UIViewController
    var id = scenario
    var fields: [String: Any] = [:]
    let variants = ["session-preview-": "session-preview", "activity-preview-": "activity-preview",
      "settings-baseline-": "settings-baseline", "edit-message-": "edit-message-preview"]
    for (prefix, page) in variants where scenario.hasPrefix(prefix) && scenario != page {
      id = page; fields["scenario"] = String(scenario.dropFirst(prefix.count)); break
    }
    if ["send-queue", "send-guide", "send-interrupt", "send-scroll-guide", "send-scroll-queue", "send-scroll-normal"].contains(scenario) {
      id = "send-preview"
      fields["queue"] = scenario != "send-scroll-normal"
      fields["steer"] = scenario != "send-interrupt"
      fields["longContext"] = scenario.hasPrefix("send-scroll-")
      fields["queuedMessageBehavior"] = scenario.hasSuffix("guide") ? "guide" : "queue"
    }
    let aliases = ["pull-request-preview": "pull-request-native-preview", "permission-native-waiting": "permission-native-preview",
      "appearance-preview": "settings", "diagnostics-settings-preview": "settings",
      "preferences-preview": "preferences", "queued-message-behavior-preview": "preferences",
      "project-preview-empty": "project-preview", "project-preview-offline": "project-preview"]
    id = aliases[id] ?? id
    if scenario == "permission-native-waiting" { fields["waiting"] = true }
    if scenario == "item-detail-preview" { fields["scenario"] = "paging" }
    if scenario == "project-preview-empty" || scenario == "project-preview-offline" { fields["projectId"] = "preview-empty" }
    if scenario == "project-preview-offline" { fields["offline"] = true }
    if ["create-parity", "create-recovery", "create-scope", "model-memory", "project-picker-preview"].contains(scenario) {
      content = CreateSessionPreviewController(scenario: scenario == "project-picker-preview" ? "create-parity" : scenario)
    } else {
      guard let page = LodyNativePages.make(id, params: SessionController.json(fields)) else {
        preconditionFailure("Missing native verification scene: \(scenario)")
      }
      content = page
    }
    if scenario.hasPrefix("session-preview-bar-") {
      LodyShell.shared.pushRootNative(content, title: "")
      return
    }
    let onboarding = content is OnboardingController
    let regular = LodyShell.shared.presenter?.traitCollection.horizontalSizeClass == .regular
    LodyShell.shared.presentNative(content, title: content.title ?? "", detents: [1], grabber: !onboarding,
      dismissible: !onboarding, style: regular ? "formSheet" : "pageSheet",
      headerShown: !onboarding && !(content is CreateSessionHostController))
  }
}

final class NativeDebugController: UIViewController {
  private static let groups: [(id: String, header: String, rows: [(String, String, String)])] = [
    ("ui", "界面验收", [
      ("create-recovery", "Device recovery verification", "desktopcomputer"),
      ("pull-request-preview", "GitHub PR / CI 预览", "arrow.triangle.pull"),
      ("project-picker-preview", "选择项目验收", "folder"),
      ("notification-preview", "通知权限验收", "bell"),
      ("push-subscription-verify", "验证 OneSignal 订阅", "bell.badge"),
      ("permission-native-preview", "权限验收", "hand.raised"),
      ("onboarding-preview", "登录引导验收", "hand.wave"),
      ("project-history-preview", "项目会话同步验收", "arrow.triangle.2.circlepath"),
      ("directory-preview", "Folder browser", "folder"),
      ("project-preview", "Project page", "folder.badge.gearshape"),
      ("activity-preview", "Activity page", "bolt.horizontal"),
      ("settings-preview", "远程设置验收", "gear"),
      ("settings-baseline-live", "Settings baseline", "gearshape.2"),
      ("ai-usage-preview", "AI usage", "chart.bar"),
      ("mcp-settings-preview", "MCP 设置验收", "server.rack"),
      ("memory-preview", "Memory acceptance", "brain"),
      ("published-shares-preview", "Published shares acceptance", "link"),
      ("memory-states-preview", "Memory states", "brain"),
      ("agent-roles-preview", "Agent 角色验收", "person.crop.square"),
      ("archived-sessions-preview", "Archived sessions", "archivebox"),
      ("session-preview-live", "Native session", "bubble.left"),
      ("machine-settings-preview", "机器设置验收", "desktopcomputer"),
      ("preferences-preview", "偏好设置验收", "slider.horizontal.3"),
      ("diagnostics-preview", "Diagnostics", "waveform.path.ecg"),
      ("appearance-preview", "外观验收", "circle.lefthalf.filled"),
      ("queued-message-behavior-preview", "排队消息行为验收", "arrow.uturn.forward"),
      ("model-memory", "Model memory verification", "brain"),
      ("create-parity", "Create parity verification", "square.on.square"),
    ]),
    ("chat", "聊天与输入", [
      ("item-detail-preview", "Item details", "doc.text.magnifyingglass"),
      ("edit-message-preview", "Message editing", "pencil"),
      ("file-diff-preview", "Native diff", "plus.forwardslash.minus"),
      ("workspace-changes-preview", "Native workspace changes", "arrow.triangle.branch"),
      ("file-content-preview", "Native file content", "doc"),
      ("agent-error-preview", "Agent 错误预览", "exclamationmark.circle"),
    ]),
    ("send", "发送", [
      ("send-preview", "离线发送验收", "paperplane"),
      ("send-queue", "Queue 验收", "list.bullet"),
      ("session-share-preview", "Conversation sharing", "link"),
      ("send-guide", "引导发送验收", "arrow.uturn.forward"),
      ("send-scroll-guide", "长上下文 · 直接插话", "arrow.uturn.forward"),
      ("send-scroll-queue", "长上下文 · 队列插话", "list.bullet"),
      ("send-scroll-normal", "长上下文 · 普通发送", "paperplane"),
      ("send-interrupt", "Queue 中断验收", "stop.circle"),
    ]),
  ]

  private let list = LodyGroupedList(frame: .zero)
  private var observer: NSObjectProtocol?

  init() { super.init(nibName: nil, bundle: nil); title = "Debug" }
  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in
      guard name == "rowPress", let id = body["id"] as? String else { return }
      self?.press(id)
    }
    list.setPlaceholder("")
    observer = NotificationCenter.default.addObserver(forName: .lodyDataRuntimeEvent, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.render() }
    }
    render()
  }

  private func render() {
    var sections = Self.groups.map { group in
      LodyListSection.group(group.id, header: group.header, group.rows.compactMap { id, title, image -> LodyListRow? in
        #if !DEBUG
        if id == "push-subscription-verify" { return nil }
        #endif
        return LodyListRow.item(id, title, image: image, disclosure: id != "push-subscription-verify")
      })
    }
    var hang = LodyListRow.item("runtime-hang", "卡死 WebView JS", image: "exclamationmark.triangle")
    hang.destructive = true
    sections.append(.group("runtime", header: "数据运行时",
      footer: "故障注入会暂时中断同步。看门狗应自动重建；连续故障达到上限后，请返回项目页下拉重新同步。", [
        runtimeRow(),
        hang,
        .item("runtime-restart", "模拟 WebContent 进程丢失", image: "arrow.clockwise"),
      ]))
    list.setSections(sections)
  }

  private func runtimeRow() -> LodyListRow {
    guard let status = DataRuntime.current?.status() else {
      return .item("runtime-state", "无法读取运行时状态", image: "cpu", action: false)
    }
    let generation = (status["generation"] as? Int).map { "#\($0)" }
    let details = [generation, status["reason"] as? String, status["lastStartReason"] as? String]
      .compactMap { $0 }.filter { !$0.isEmpty }
    return .item("runtime-state", status["state"] as? String ?? "unknown", subtitle: details.joined(separator: " · "),
      image: "cpu", action: false, subtitleMono: true)
  }

  private func press(_ id: String) {
    switch id {
    case "runtime-hang": DataRuntime.current?.debugHang()
    case "runtime-restart": DataRuntime.current?.debugRestart()
    #if DEBUG
    case "push-subscription-verify":
      PushNotifications.shared.onRegistered = { [weak self] in
        guard let self else { return }
        PushNotifications.shared.verify(from: self)
      }
      PushNotifications.shared.verify(from: self)
    #endif
    default: NativeDebug.open(["verifyCase": id])
    }
  }
}

@MainActor
enum NativeHomeFixture {
  static var active: Bool { LodyUIVerify.enabled && SessionCatalogPreview.state != nil }
  static func request(_ action: String, _ fields: [String: Any]) async throws {
    precondition(active, "Preview actions require an offline fixture")
    try apply(action, fields)
  }
  static func routingContext() -> NotificationNavigation.Context {
    let state = SessionSource.live.state
    return .init(ready: true, userId: state.userId,
      workspaces: workspaces.map { ($0["id"] as! String, $0["slug"] as? String) },
      selectedId: state.workspaceId, loading: state.loading, connected: state.connected,
      sessionIds: Set(state.catalog.sessions.map(\.id)))
  }
  private static var presence: [String: Any] = ["state": "live", "onlineMachineIds": ["ui", "mini"]]
  private static var polling: Task<Void, Never>?

  private static var catalog: [String: Any] = [:]
  private static var statesCatalog: [String: Any] = [:]
  private static var workspaces: [[String: Any]] = []
  private static var selected = "ui-home"
  private static var rejectedDelete = false
  private static var syncPreview = false

  static func prepare() throws {
    let url = Bundle.main.url(forResource: "DebugHome", withExtension: "json")!
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    catalog = fixture["catalog"] as! [String: Any]
    if LodyUIVerify.has("--ui-verify-sticky-groups") {
      HomeGrouping.store(.project)
      let names = ["Alpha project", "Beta project", "Gamma project"]
      catalog["projects"] = names.enumerated().map { index, name in
        ["id": "sticky-\(index)", "name": name, "machineId": "ui", "rootPath": "/tmp/sticky-\(index)"]
      }
      catalog["sessions"] = names.indices.flatMap { group in
        (0..<18).map { row -> [String: Any] in
          ["id": "sticky-\(group)-\(row)", "title": "Conversation \(group + 1).\(row + 1) — scrolling behind header",
           "projectId": "sticky-\(group)", "machineId": "ui", "status": "completed",
           "createdAt": "2026-09-0\(7 - group)T10:00:00Z", "archived": false, "pinned": false]
        }
      }
    }
    statesCatalog = relative(fixture["statesCatalog"] as! [String: Any], now: Date().timeIntervalSince1970 * 1000)
    workspaces = fixture["workspaces"] as! [[String: Any]]
    for case let (photo, source as String) in fixture["photoCache"] as? [String: Any] ?? [:] {
      if let url = URL(string: photo), let data = URL(string: source) { LodyListPhoto.prime(url, from: data) }
    }
    selected = "ui-home"; rejectedDelete = false
    syncPreview = LodyUIVerify.has("--ui-verify-home-syncing")
    if LodyUIVerify.has("--ui-verify-home-sync-cycle") {
      Task {
        try? await Task.sleep(for: .seconds(3))
        syncPreview = true; publish()
        try? await Task.sleep(for: .seconds(4))
        syncPreview = false; publish()
      }
    }
    for key in ["inboxView", "inboxProjectSort", "inboxExpansion", "inboxPinOrder.ui-home.ui-home"] {
      UserDefaults.standard.removeObject(forKey: key)
    }
    let catalogJSON = SessionController.json(["catalog": catalog, "syncedAt": 0])
    try LocalStore.queue.sync {
      let store = LocalStore.shared
      try store.write("ui-device-presence", "{\"state\":\"live\",\"onlineMachineIds\":[\"ui\",\"mini\"]}")
      try store.write("catalog:ui-home:ui-home", catalogJSON)
      try store.write("pending-sends:ui-home:ui-home", "[]")
      try store.write("draft:ui-home:ui-home:ui-design", "")
      let search = LodyUIVerify.has("--ui-verify-search")
      try store.write("session:[\"ui-home\",\"ui-home\",\"ui-design\"]", fixture[search ? "searchPreviewCache" : "previewCache"] as! String)
      try store.write("session:[\"ui-home\",\"ui-home\",\"ui-search\"]", search ? fixture["olderSearchCache"] as! String : "null")
      try store.write("session:[\"ui-home\",\"ui-states\",\"st-sync\"]", fixture["statesProseCache"] as! String)
    }
    publish()
    polling?.cancel()
    polling = Task {
      var previous = ""
      while !Task.isCancelled {
        let raw: String? = await withCheckedContinuation { done in
          LocalStore.queue.async { done.resume(returning: try? LocalStore.shared.read("ui-device-presence")) }
        }
        if let raw, raw != previous {
          previous = raw
          presence = try! JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]
          publish()
        }
        try? await Task.sleep(for: .milliseconds(500))
      }
    }
  }

  static func apply(_ action: String, _ fields: [String: Any]) throws {
    switch action {
    case "selectWorkspace": selected = fields["workspaceId"] as! String
    case "updateWorkspace", "updateWorkspaceIcon":
      let id = fields["workspaceId"] as! String
      guard let index = workspaces.firstIndex(where: { $0["id"] as? String == id }) else { preconditionFailure("Unknown fixture workspace") }
      if action == "updateWorkspace" { workspaces[index]["name"] = fields["name"] }
      else { workspaces[index]["image"] = fields["uri"] }
    case "deleteSessions":
      if fields["sessionId"] as? String == "ui-search", !rejectedDelete {
        rejectedDelete = true
        throw NSError(domain: "OfflineFixture", code: 1)
      }
      let ids = fields["sessionIds"] as! [String]
      catalog["sessions"] = (catalog["sessions"] as! [[String: Any]]).filter { !ids.contains($0["id"] as! String) }
    default: preconditionFailure("Unknown fixture action: \(action)")
    }
    publish()
  }

  private static func relative(_ fixture: [String: Any], now: Double) -> [String: Any] {
    var result = fixture
    result["sessions"] = (fixture["sessions"] as! [[String: Any]]).map { session in
      var session = session
      for (offset, field) in [("ago", "lastMessageAt"), ("readAgo", "lastReadAt"), ("awaitingAgo", "awaitingUserSince")] {
        guard let seconds = session.removeValue(forKey: offset) as? Double else { continue }
        session[field] = now - seconds * 1000
      }
      return session
    }
    return result
  }

  private static func publish() {
    let catalogs = ["ui-home": catalog, "ui-states": statesCatalog]
    let empty: [String: Any] = ["projects": [], "sessions": [], "machineIds": []]
    let payload: [String: Any] = ["account": ["user": ["id": "ui-home", "name": "UI Preview", "email": ""], "workspaces": workspaces],
      "workspaceId": selected, "catalog": catalogs[selected] ?? empty,
      "loading": syncPreview,
      "presence": ["workspaceId": selected, "presence": presence]]
    let json = String(decoding: try! JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
    SettingsPreview.set(json)
    SessionCatalogPreview.set(json)
  }
}
