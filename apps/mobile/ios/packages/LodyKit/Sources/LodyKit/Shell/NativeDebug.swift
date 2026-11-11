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
    } else if LodyUIVerify.has("--ui-review-usage") || LodyUIVerify.has("--ui-review-usage-popup") {
      root = SessionPreviewController(scenario: LodyUIVerify.has("--ui-review-usage-popup") ? "usage-popup" : "usage")
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
    if scenario.hasPrefix("schedule-fixture-") {
      ScheduleFixture.shared.control(String(scenario.dropFirst("schedule-fixture-".count)))
      return
    }
    if scenario.hasPrefix("toast-") {
      guard LodyUIVerify.enabled, let presenter = LodyShell.shared.presenter else { return }
      LodyToastOverlay.shared.dismiss()
      if ["toast-archive", "toast-unarchive", "toast-error"].contains(scenario) {
        let session = SessionItem(id: "toast-session", title: "Toast verification", archived: scenario == "toast-unarchive")
        let state = SessionListState(userId: "toast-user", workspaceId: "toast-workspace", catalog: SessionCatalog(sessions: [session]))
        let source = SessionSource(changes: [], read: { state }, write: { _, _, _ in
          if scenario == "toast-error" { throw NSError(domain: "ToastVerification", code: 1) }
        })
        SessionActions(source: source).perform("archive", row: session.id, from: presenter)
      } else {
        let kind: LodyToastKind = scenario == "toast-warning" ? .warning : .neutral
        let key = scenario == "toast-warning" ? "create.toast.branchRequired" : "diff.toast.copied"
        LodyToastOverlay.shared.show(message: String(localized: String.LocalizationValue(key), bundle: .lody), kind: kind)
      }
      return
    }
    if scenario == "inline-code" {
      let page = UIViewController()
      page.view.backgroundColor = .lodyBackground
      let store = ChatMarkdownStore(traits: page.traitCollection)
      let markdown = store.view(id: "inline-preview",
        text: "Body with `inline code` and **`bold code`**.\n\n```\nfenced code keeps its ink\n```",
        secondary: false, streaming: false, width: 330)
      markdown.frame = CGRect(x: 24, y: 120, width: 330, height: markdown.measuredHeight)
      page.view.addSubview(markdown)
      LodyShell.shared.pushRootNative(page, title: "Inline code")
      ChatContextViewProbe.checkInlineCode()
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
    if ["send-queue", "send-guide", "send-interrupt", "send-scroll-guide", "send-scroll-queue", "send-scroll-normal", "send-header-preview"].contains(scenario) {
      id = "send-preview"
      fields["queue"] = scenario != "send-scroll-normal" && scenario != "send-header-preview"
      fields["steer"] = scenario != "send-interrupt"
      fields["longContext"] = scenario.hasPrefix("send-scroll-") || scenario == "send-header-preview"
      fields["headerPreview"] = scenario == "send-header-preview"
      fields["queuedMessageBehavior"] = scenario.hasSuffix("guide") ? "guide" : "queue"
    }
    let aliases = ["pull-request-preview": "pull-request-native-preview", "permission-native-waiting": "permission-native-preview",
      "diagnostics-settings-preview": "settings",
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
    if scenario.hasPrefix("session-preview-bar-") || scenario.hasPrefix("session-preview-usage") {
      LodyShell.shared.pushRootNative(content, title: "")
      return
    }
    let onboarding = content is OnboardingController
    let regular = LodyShell.shared.presenter?.traitCollection.horizontalSizeClass == .regular
    // Sign-in covers the phone like web /login; elsewhere it is a sheet.
    var style = regular ? "formSheet" : "pageSheet"
    if onboarding && !regular { style = "fullScreen" }
    LodyShell.shared.presentNative(content, title: content.title ?? "", detents: [1], grabber: !onboarding,
      dismissible: !onboarding, style: style,
      headerShown: !onboarding && !(content is CreateSessionHostController))
  }
}

final class NativeDebugController: UIViewController {
  private static let groups: [(id: String, header: String, rows: [(String, String, String)])] = [
    ("ui", String(localized: "debug.native.ui.verification", bundle: .lody), [
      ("create-recovery", "Device recovery verification", "desktopcomputer"),
      ("pull-request-preview", String(localized: "debug.native.github.pr.ci.preview", bundle: .lody), "arrow.triangle.pull"),
      ("project-picker-preview", String(localized: "debug.native.project.picker.verification", bundle: .lody), "folder"),
      ("notification-preview", String(localized: "debug.native.notification.permission.verification", bundle: .lody), "bell"),
      ("push-subscription-verify", String(localized: "debug.native.verify.onesignal.subscription", bundle: .lody), "bell.badge"),
      ("permission-native-preview", String(localized: "debug.native.permission.verification", bundle: .lody), "hand.raised"),
      ("onboarding-preview", String(localized: "debug.native.onboarding.verification", bundle: .lody), "hand.wave"),
      ("directory-preview", "Folder browser", "folder"),
      ("project-preview", "Project page", "folder.badge.gearshape"),
      ("activity-preview", "Activity page", "bolt.horizontal"),
      ("agent-providers-preview", "Agent providers", "sparkles"),
      ("agent-presets-preview", "Agent provider presets", "sparkles"),
      ("agent-auth-methods-preview", "Agent authentication methods", "sparkles"),
      ("agent-pi-preview", "Agent Pi extensions", "sparkles"),
      ("settings-preview", String(localized: "debug.native.remote.settings.verification", bundle: .lody), "gear"),
      ("settings-baseline-live", "Settings baseline", "gearshape.2"),
      ("ai-usage-preview", "AI usage", "chart.bar"),
      ("agent-roles-preview", String(localized: "debug.native.agent.role.verification", bundle: .lody), "person.crop.square"),
      ("archived-sessions-preview", "Archived sessions", "archivebox"),
      ("session-preview-live", "Native session", "bubble.left"),
      ("machine-settings-preview", String(localized: "debug.native.machine.settings.verification", bundle: .lody), "desktopcomputer"),
      ("preferences-preview", String(localized: "debug.native.preferences.verification", bundle: .lody), "slider.horizontal.3"),
      ("diagnostics-preview", "Diagnostics", "waveform.path.ecg"),
      ("queued-message-behavior-preview", String(localized: "debug.native.queued.message.behavior.verification", bundle: .lody), "arrow.uturn.forward"),
      ("model-memory", "Model memory verification", "brain"),
      ("create-parity", "Create parity verification", "square.on.square"),
    ]),
    ("chat", String(localized: "debug.native.chat.and.input", bundle: .lody), [
      ("item-detail-preview", "Item details", "doc.text.magnifyingglass"),
      ("edit-message-preview", "Message editing", "pencil"),
      ("file-diff-preview", "Native diff", "plus.forwardslash.minus"),
      ("workspace-changes-preview", "Native workspace changes", "arrow.triangle.branch"),
      ("file-content-preview", "Native file content", "doc"),
      ("agent-error-preview", String(localized: "debug.native.agent.error.preview", bundle: .lody), "exclamationmark.circle"),
    ]),
    ("send", String(localized: "debug.native.sending", bundle: .lody), [
      ("send-preview", String(localized: "debug.native.offline.send.verification", bundle: .lody), "paperplane"),
      ("send-queue", String(localized: "debug.native.queue.verification", bundle: .lody), "list.bullet"),
      ("session-share-preview", "Conversation sharing", "link"),
      ("send-guide", String(localized: "debug.native.guided.send.verification", bundle: .lody), "arrow.uturn.forward"),
      ("send-scroll-guide", String(localized: "debug.native.long.context.direct.interjection", bundle: .lody), "arrow.uturn.forward"),
      ("send-scroll-queue", String(localized: "debug.native.long.context.queued.interjection", bundle: .lody), "list.bullet"),
      ("send-scroll-normal", String(localized: "debug.native.long.context.normal.send", bundle: .lody), "paperplane"),
      ("send-interrupt", String(localized: "debug.native.queue.interrupt.verification", bundle: .lody), "stop.circle"),
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
    var hang = LodyListRow.item("runtime-hang", String(localized: "debug.native.hang.webview.javascript", bundle: .lody), image: "exclamationmark.triangle")
    hang.destructive = true
    sections.append(.group("runtime", header: String(localized: "debug.native.data.runtime", bundle: .lody),
      footer: String(localized: "debug.native.faultExplanation", bundle: .lody), [
        runtimeRow(),
        hang,
        .item("runtime-restart", String(localized: "debug.native.simulate.webcontent.process.loss", bundle: .lody), image: "arrow.clockwise"),
      ]))
    list.setSections(sections)
  }

  private func runtimeRow() -> LodyListRow {
    guard let status = DataRuntime.current?.status() else {
      return .item("runtime-state", String(localized: "debug.native.runtime.status.unavailable", bundle: .lody), image: "cpu", action: false)
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
    let payload: [String: Any] = ["account": ["user": ["id": "ui-home", "name": "UI Preview", "email": "preview@example.test"], "workspaces": workspaces],
      "workspaceId": selected, "catalog": catalogs[selected] ?? empty,
      "loading": syncPreview,
      "presence": ["workspaceId": selected, "presence": presence]]
    let json = String(decoding: try! JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
    SettingsPreview.set(json)
    SessionCatalogPreview.set(json)
  }
}
