import LodyCore
import UIKit

@MainActor
final class SessionPreviewController: SessionController {
  private let scenario: String
  private let fixture: SessionPreviewFixture
  private let probe = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))

  init(scenario: String) {
    precondition(!scenario.hasPrefix("cards-") || _isDebugAssertConfiguration())
    self.scenario = scenario
    let fixture = SessionPreviewFixture(offline: scenario == "offline", tools: LodyUIVerify.has("--ui-verify-process-tools"), bar: scenario)
    self.fixture = fixture
    super.init(
      sessionId: SessionPreviewFixture.sessionId, findQuery: scenario == "find" ? "needle" : "",
      source: SessionSource(
        changes: [SessionPreviewFixture.change], read: { fixture.state },
        write: { _, id, write in try await fixture.write(id, write) }
      ),
      feed: SessionFeedService(
        watch: { _, receive in fixture.watch(receive) },
        reconnect: { _ in fixture.reconnect() },
        cached: { _, _, _ in SessionPreviewFixture.envelope(status: "syncing", revision: 0, reply: "Cached reply") }
      ),
      itemDetail: ItemDetailService(load: { params in
        .init(itemId: params.itemId, rev: 1, blocks: [.object([
          "type": .string("terminal_output"), "output": .string("Native session tool detail"),
        ])], truncated: false)
      }, observe: { _ in {} }),
      simulator: .init(call: { command in
        if case .stop = command { return .init(success: true) }
        if case .list = command {
          return .init(success: true, devices: [.init(udid: "native-fixture-phone", name: "Fixture Phone", runtime: "iOS 27", deviceType: "iPhone", state: "Booted", available: true, occupancy: .available)])
        }
        return .init(success: true, preview: .init(operationId: "native-fixture", udid: "native-fixture-phone", phase: .ready, transport: .remote, viewerUrl: "lody-simulator-fixture://stream"))
      }),
      pullRequest: { reference, _ in PullRequestPreviewController(params: scenario.hasPrefix("bar-") ? ["state": reference.status, "reference": reference] : [:]) },
      browser: { _, _ in .init(url: "https://native-fixture.trycloudflare.com") }
    )
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  /// Copy submenu reads, scripted so the menu runs offline.
  static let copyFixture = SessionCopyService(
    workspacePath: { _, _ in "/Users/preview/.lody/repos/github---innei---lody-ios/worktrees/native-session" },
    markdown: { _ in
      .ready(.init(markdown: "# Native session preview\n\nLive reply with a needle\n", estimatedTokens: 12, overBudget: false,
                   toolCallsCollapsed: false, thinkingTruncated: false, terminalTrimmed: false, toolResultsTruncated: 0))
    }
  )

  override var persistsDraft: Bool { false }

  override var resourceItems: [[String: Any]] {
    guard scenario.hasPrefix("bar-") else { return super.resourceItems }
    return SessionActionBarPreview.resources(scenario, browser: browserItem)
  }

  override func adjustComposer(_ state: inout [String: Any]) {
    if scenario.hasPrefix("usage") {
      state["connection"] = ""
      state["usage"] = [
        "context": ["used": 84_000, "size": 200_000],
        "modelLabel": "Claude Sonnet 4.5",
        "quota": ["windows": [
          ["usedPercent": 21, "duration": 604_800, "resetsAt": 1_800_000_000],
          ["usedPercent": 63, "duration": 18_000, "resetsAt": 1_799_600_000],
        ]],
      ]
      return
    }
    guard scenario.hasPrefix("bar-") else { return }
    state["connection"] = ""
    if scenario == "bar-running", let session = source.state.catalog.session(sessionId) {
      state["actionBar"] = actionBarState(session, busy: true)
    }
    if ["bar-ready-pending", "bar-merge-pending"].contains(scenario) {
      var bar = state["actionBar"] as? [String: Any] ?? [:]
      let key = scenario == "bar-ready-pending" ? "bar.ready.pending" : "bar.merge.pending"
      bar["primary"] = ["label": String(localized: String.LocalizationValue(key), bundle: .lody), "busy": true, "more": [], "moreLabel": ""]
      state["actionBar"] = bar
    }
  }

  override func viewDidLoad() {
    probe.isAccessibilityElement = true
    probe.accessibilityIdentifier = "session-preview-probe"
    probe.accessibilityLabel = scenario.hasPrefix("cards-") ? "Offline card review: " + scenario : "Native session preview"
    copyService = Self.copyFixture
    super.viewDidLoad()
    // Two members make Change owner available, as in a team workspace.
    chat.members = [
      "preview-user": WorkspaceMember(id: "preview-user", name: "Preview User", image: nil),
      "preview-teammate": WorkspaceMember(id: "preview-teammate", name: "Ada Lovelace", image: nil),
    ]
    render()
    if scenario.hasPrefix("cards-") {
      chat.onProposalDecision = { [weak self] row, accept in
        self?.fixture.decideCard(itemId: row.itemID, accept: accept)
        self?.chat.setProposalState(entryId: row.entryID, itemId: row.itemID, nil)
      }
      chat.onProposalOpenSchedule = { [weak self] _ in
        guard let self else { return }
        LodyShell.shared.presentNative(
          SchedulesController(source: source, service: ScheduleFixture.shared.service),
          title: String(localized: "native.chat.proposal.schedules", bundle: .lody), detents: [1])
      }
      if scenario == "cards-states" {
        chat.setProposalState(entryId: "preview-answer", itemId: "error", .init(message: String(localized: "native.chat.proposal.error.failed", bundle: .lody)))
        chat.setProposalState(entryId: "preview-answer", itemId: "pending", .init(pending: true))
      }
    }
    if scenario.hasPrefix("bar-") {
      let action = chat.onPreview
      chat.onPreview = { [weak self] body in
        guard let self else { return }
        let id = body["action"] as? String ?? ""
        if id == "bar:context:diff" || id == "bar:diff" {
          LodyShell.shared.presentDetail(WorkspaceChangesPreviewController(), title: String(localized: "workspaceChanges.title", bundle: .lody), from: self)
        } else if id == "bar:act", self.infoBar?.actions.first != .merge {
          // Screenshot fixtures never send prompts or write to GitHub.
          return
        } else if id.hasPrefix("bar:more:") { return }
        else { action(body) }
      }
    }
    if scenario == "mentions" {
      // Offline fixture: input and bubble exercise the production native renderers.
      chat.onSend = { _ in }
      func findInput(_ view: UIView) -> ChatComposerInput? {
        if let input = view as? ChatComposerInput { return input }
        return view.subviews.lazy.compactMap(findInput).first
      }
      if let input = findInput(chat.composer) {
        input.text = "@Same title "
        input.insertReference("@session:first", label: "@Same title", replacing: NSRange(location: (input.text as NSString).length, length: 0))
        input.insertReference("@session:second", label: "@Same title", replacing: NSRange(location: (input.text as NSString).length, length: 0))
        let expected = input.markdown
        precondition(expected.contains("@Same title @session:first @session:second"))
        let draft = input.draftEnvelope
        input.text = ""
        input.restoreDraft(draft)
        precondition(input.markdown == expected && !input.text.contains("session:"))
        input.text = ""
        input.insertReference("@session:fixture-session", label: "@Fix sign-in", replacing: NSRange(location: 0, length: 0))
        input.insertReference("@role:fixture-role", label: "🧪 Reviewer", replacing: NSRange(location: (input.text as NSString).length, length: 0))
      }
    }
    view.addSubview(probe)
    fixture.changed = { [weak self] in self?.updateProbe() }
    updateProbe()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if scenario.hasPrefix("usage") { chat.composer.usageNow = { Date(timeIntervalSince1970: 1_799_596_400) } }
    if scenario == "usage-popup" { chat.composer.presentUsage() }
    if scenario == "bar-tabs" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.chat.onTitlePress([:]) }
    }
  }

  private func updateProbe() {
    probe.accessibilityValue = fixture.log.joined(separator: ",")
  }
}

@MainActor
private final class SessionPreviewFixture {
  static let change = Notification.Name("LodySessionPreviewFixture")
  static let sessionId = "native-session"
  private(set) var log: [String] = []
  var changed: (() -> Void)?
  private let offline: Bool
  private let tools: Bool
  private let bar: String
  private var catalog: SessionCatalog
  private var receive: (@MainActor (SessionRuntimeEvent) -> Void)?
  private var revision = 1
  private var cardOutcomes: [String: String] = [:]

  init(offline: Bool, tools: Bool = false, bar: String = "", now: Double = LodyRelativeTime.now()) {
    self.bar = bar
    self.offline = offline
    self.tools = tools
    catalog = SessionCatalog(
      projects: [SessionProject(id: "preview-lody", name: "Lody", rootPath: "/Users/preview/lody")],
      sessions: [
        SessionItem(
          id: Self.sessionId, title: "Native session preview", status: "idle", userId: "preview-user", projectId: "preview-lody",
          lastMessageAt: now - 60_000, branchName: "feature/native-session", baseBranch: "main", machineId: "preview-mac",
          pullRequests: [.init(repository: "Innei/lody-ios", number: 31, status: "open", ci: "f")]
        ),
      ],
      machineIds: ["preview-mac"], machineNames: ["preview-mac": "Preview Mac"], machineSimulators: ["preview-mac": "available"]
    )
    if bar == "archived" { catalog.sessions[0].archived = true }
    if bar == "bar-tabs", let root = catalog.sessions.first {
      var tab = root
      tab.id = "preview-second-tab"
      tab.title = String(localized: "session.tabs.defaultTitle", bundle: .lody) + " 2"
      tab.parentSessionId = root.id
      tab.status = "idle"
      catalog.sessions.append(tab)
      var closed = tab
      closed.id = "preview-closed-tab"
      closed.title = String(localized: "session.tabs.defaultTitle", bundle: .lody) + " 3"
      closed.isTabClosed = true
      catalog.sessions.append(closed)
    }
    if bar.hasPrefix("bar-") { SessionActionBarPreview.configure(&catalog, scenario: bar) }
  }

  var state: SessionListState {
    SessionListState(
      userId: "preview-user", workspaceId: "preview-workspace",
      presence: SettingsMachinePresence(state: bar == "bar-unknown" ? "syncing" : "live", onlineMachineIds: bar == "bar-offline" ? [] : ["preview-mac"]),
      workspaces: [AuthWorkspace(id: "preview-workspace", name: "Preview", slug: "preview", image: nil)], catalog: catalog
    )
  }

  func watch(_ receive: @escaping @MainActor (SessionRuntimeEvent) -> Void) -> @MainActor () -> Void {
    self.receive = receive
    record("watch")
    emit()
    return { [weak self] in
      self?.receive = nil
      self?.record("unwatch")
    }
  }

  func reconnect() {
    record("reconnect")
    revision += 1
    emit(forceLive: true)
  }

  func write(_ id: String, _ change: SessionWrite) async throws {
    guard let index = catalog.sessions.firstIndex(where: { $0.id == id }) else { return }
    switch change {
    case .tabClosed(let closed):
      catalog.sessions[index].isTabClosed = closed
      record(closed ? "close-tab" : "restore-tab")
    case .archive(let archived):
      if bar == "archive-error" { throw NSError(domain: "SessionPreview", code: 1) }
      catalog.sessions[index].archived = archived
      record(archived ? "archive" : "unarchive")
    case .owner(let userId):
      catalog.sessions[index].userId = userId
      record("owner:\(userId)")
    case .rename(let title):
      catalog.sessions[index].title = title
      record("rename")
    case .delete:
      try await Task.sleep(for: .milliseconds(300))
      catalog.sessions.removeAll { $0.id == id }
      record("delete")
    case .pin, .read:
      return
    }
    NotificationCenter.default.post(name: Self.change, object: nil)
  }

  func decideCard(itemId: String, accept: Bool) {
    cardOutcomes[itemId] = accept ? (bar == "cards-schedules" ? "created" : "saved") : "dismissed"
    revision += 1
    emit()
  }

  private func emit(forceLive: Bool = false) {
    let status = offline && !forceLive ? "offline" : "live"
    var session = Self.envelope(status: status, revision: revision, reply: "Live reply with a needle", tools: tools)
    if bar.hasPrefix("bar-"), let data = session?.data(using: .utf8),
       var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       var entries = object["entries"] as? [[String: Any]] {
      entries[0]["items"] = [["itemId": "text", "type": "text", "text": SessionActionBarPreview.text("prompt")]]
      entries[1]["items"] = [["itemId": "reply", "type": "text", "text": SessionActionBarPreview.text("reply")]]
      if bar == "bar-tasks" || bar == "bar-crowded" {
        var items = entries[1]["items"] as! [[String: Any]]
        for index in 1...3 {
          items.insert(["itemId": "task-\(index)", "type": "subagent_task", "taskId": "review-\(index)", "status": "in_progress", "actor": SessionActionBarPreview.text("task") + " \(index)", "description": SessionActionBarPreview.text("taskDescription")], at: 0)
        }
        entries[1]["items"] = items
      }
      object["entries"] = entries
      session = SessionController.json(object)
    }
    if bar == "mentions", let data = session?.data(using: .utf8),
       var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       var entries = object["entries"] as? [[String: Any]] {
      let text = "Please review @Fix sign-in with 🧪 Reviewer and @src/auth/login.ts."
      let source = text as NSString
      let refs = ["@Fix sign-in", "🧪 Reviewer"].enumerated().map { index, label -> [String: Any] in
        let range = source.range(of: label)
        return ["start": range.location, "end": NSMaxRange(range), "kind": index == 0 ? "session" : "agent_role"]
      }
      entries[0]["items"] = [["itemId": "text", "type": "text", "text": text, "references": refs]]
      entries[1]["items"] = [["itemId": "reply", "type": "text", "text": "References keep their readable names in the conversation."]]
      object["entries"] = entries
      session = SessionController.json(object)
    }
    if bar.hasPrefix("cards-") {
      session = Self.cardsEnvelope(scenario: bar, revision: revision, outcomes: cardOutcomes)
    }
    // Deliver after the cached frame, the way the runtime answers an open.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      MainActor.assumeIsolated {
        guard let self, let receive = self.receive else { return }
        if status == "offline" {
          receive(SessionRuntimeEvent(generation: 1, state: "failed"))
        } else {
          receive(SessionRuntimeEvent(generation: 1, state: "live", sessionId: Self.sessionId, session: session))
        }
        self.record(status)
      }
    }
  }

  private func record(_ entry: String) {
    log.append(entry)
    changed?()
  }

  /// Synthetic summaries in the same JSON shape delivered by the cloud runtime.
  /// Keep taller cards separate so each launch is a useful phone screenshot.
  nonisolated static func cardsEnvelope(scenario: String, revision: Int, outcomes: [String: String]) -> String {
    func role(_ id: String, fields: [String: String], before: [String: String]? = nil,
              owner: String = "preview-user", outcome: String? = nil) -> [String: Any] {
      var proposal: [String: Any] = ["kind": "agent_role", "action": before == nil ? "create" : "update",
        "roleId": "fixture-" + id, "requesterUserId": owner, "fields": fields]
      proposal["before"] = before
      proposal["outcome"] = outcomes[id] ?? outcome
      return ["itemId": id, "type": "system_notice", "name": "agent_role_proposal", "proposal": proposal]
    }
    func schedule(_ id: String, created: Bool) -> [String: Any] {
      var proposal: [String: Any] = ["kind": "schedule", "proposalId": id, "title": "Daily review",
        "prompt": "Summarize open tasks.", "destination": "new_session",
        "rule": ["kind": "daily", "hour": 9, "minute": 0, "timeZone": "UTC"]]
      let outcome = outcomes[id] ?? (created ? "created" : nil)
      proposal["outcome"] = outcome
      if outcome == "created" { proposal["scheduleId"] = "daily-review" }
      return ["itemId": id, "type": "system_notice", "name": "schedule_proposal", "proposal": proposal]
    }
    let items: [[String: Any]]
    switch scenario {
    case "cards-role-create":
      items = [role("create", fields: ["name": "Reviewer", "description": "Reviews proposed changes.",
        "promptPrefix": "Focus on correctness and clear feedback."])]
    case "cards-role-update":
      items = [role("update", fields: ["name": "Release reviewer", "description": "Reviews release readiness.",
        "promptPrefix": "Check compatibility."], before: ["name": "Reviewer", "description": "Reviews changes.", "promptPrefix": "Check correctness."])]
    case "cards-owner-only":
      items = [role("owner", fields: ["name": "Team reviewer", "description": "Reviews team changes."], owner: "preview-teammate")]
    case "cards-receipts":
      items = [role("saved", fields: ["name": "Reviewer", "description": "Reviews changes."], outcome: "saved"),
        role("dismissed", fields: ["name": "Release helper"], outcome: "dismissed")]
    case "cards-schedules":
      items = [schedule("schedule-pending", created: false), schedule("schedule-created", created: true)]
    case "cards-states":
      items = [role("error", fields: ["name": "Reviewer"]), role("pending", fields: ["name": "Release helper"])]
    case "cards-files":
      items = [
        ["itemId": "report", "type": "file", "file": ["id": "fixture-report", "fileName": "report.pdf", "mimeType": "application/pdf", "sizeBytes": 240_000]],
        ["itemId": "notes", "type": "file", "file": ["id": "fixture-notes", "fileName": "notes.md", "mimeType": "text/markdown", "sizeBytes": 3_000]],
      ]
    default: preconditionFailure("Unknown card review scenario: \(scenario)")
    }
    let object: [String: Any] = ["v": 1, "status": "live", "revision": revision, "entries": [
      ["id": "preview-answer", "role": "assistant", "status": "completed", "finished": true,
       "endedAt": 1_793_268_064_000, "items": items],
    ]]
    return String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
  }

  nonisolated static func envelope(status: String, revision: Int, reply: String, tools: Bool = false) -> String? {
    var object: [String: Any] = [
      "v": 1, "status": status, "revision": revision,
      "preview": ["label": "localhost:5173", "active": true],
      "entries": [
        [
          "id": "preview-user", "role": "user", "status": "completed", "finished": true, "timestamp": "2026-10-29T10:00:00Z",
          "items": [["itemId": "text", "type": "text", "text": "Show the native session page"]],
        ],
        [
          "id": "preview-answer", "role": "assistant", "status": "completed", "finished": true, "endedAt": 1_793_268_064_000,
          "modelInfo": ["name": "Native fixture model", "thoughtLevel": "High"],
          "items": [
            ["itemId": "edit", "rev": 1, "hasDetail": true, "type": "tool_call", "kind": "edit", "status": "completed", "title": "Edit", "path": "src/App.tsx",
             "added": 3, "removed": 1],
            ["itemId": "task", "type": "subagent_task", "taskId": "native-task", "status": "completed",
             "actor": "test-runner", "description": "Verify the native session", "summary": "Native task summary: all checks passed."],
            ["itemId": "reply", "type": "text", "text": reply],
          ],
        ],
      ],
    ]
    if tools {
      var entries = object["entries"] as! [[String: Any]]
      entries[1]["items"] = [
        ["itemId": "intro", "type": "text", "text": "I'll update the session branch name first."],
        ["itemId": "command", "type": "tool_call", "kind": "execute", "status": "completed", "hasDetail": true,
         "title": "git branch -m session/example fix/keep-tool-calls-after-prose-and-display-one-line\nprintf 'ready'"],
        ["itemId": "answer", "type": "text", "text": "Hi! What would you like to work on?"],
      ]
      object["entries"] = entries
    }
    return (try? JSONSerialization.data(withJSONObject: object)).map { String(decoding: $0, as: UTF8.self) }
  }
}
