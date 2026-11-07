import Foundation
import XCTest
import LodyCore

@MainActor
final class RuntimeContractTests: XCTestCase {
  private typealias Contract = RuntimeContract

  private func fixtures(_ name: String) throws -> [String] {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("cloud-runtime/contract/fixtures/\(name).json")
    let items = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [Any])
    return try items.map { String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }
  }

  private func json(_ text: String) throws -> NSDictionary {
    try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? NSDictionary)
  }

  private final class Harness {
    var posts: [String] = []
    var timers: [@MainActor () -> Void] = []
    var ids: [String]
    init(ids: [String] = []) { self.ids = ids }
  }

  private func channel(_ harness: Harness, generation: Int = 3) -> RuntimeChannel {
    RuntimeChannel(
      generation: generation,
      post: { harness.posts.append($0) },
      schedule: { _, work in harness.timers.append(work) },
      makeID: { harness.ids.isEmpty ? UUID().uuidString : harness.ids.removeFirst() }
    )
  }

  private func posted(_ harness: Harness, count: Int) async {
    for _ in 0..<100 where harness.posts.count < count { await Task.yield() }
  }

  func testRuntimeFixturesDecodeAsTypedInbound() throws {
    let decoded = try fixtures("to-host").map { try JSONDecoder().decode(Contract.Envelope.self, from: Data($0.utf8)) }
    let github = Contract.PromptShortcutProject.github(.init(repository: "lody/app"))
    let readme = Contract.PromptShortcutTarget.file(.init(project: github, path: "README.md"))
    let entry = Contract.PromptShortcutIndexEntry(v: 1, id: "shortcut-1", workspaceId: "workspace-1", ownerUserId: "user-1",
      visibility: .workspace, name: "Summarize", slug: "summarize", scope: .init(), revision: "rev-1",
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, bodyDocId: "body-1", dependencySummary: [])
    let saved = Contract.PromptShortcutIndexEntry(v: 1, id: "shortcut-2", workspaceId: "workspace-1", ownerUserId: "user-1",
      visibility: .workspace, name: "Review", slug: "review", scope: .init(project: github), revision: "rev-2",
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, bodyDocId: "body-2", dependencySummary: [readme])
    let role = Contract.AgentRoleItem(id: "role-1", ownerUserId: "user-1", visibility: .workspace, name: "Reviewer",
      description: "", promptPrefix: "Review carefully", revision: 1, updatedAt: 1_700_000_000_000,
      targets: [.init(machineId: "machine-1", agentConfigId: "agent-1", machineName: "Studio", agentName: "Claude", state: .configured)])
    let share = Contract.PublishedSharesResultPagePageItem(shareId: "share-1", rootSessionId: "session-1",
      publisherUserId: "user-1", status: .active, title: "Launch notes", revision: 2, credentialVersion: 1,
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, totalBytes: 2048, conversationCount: 1,
      canManage: true, canRevoke: true, hasLocalLink: false)
    let target = Contract.HistoryTarget(machineId: "machine-1", machineName: "Studio", localProjectId: "p1",
      projectName: "App", rootPath: "/Users/dev/app", provider: .init(cliType: .builtin, agentType: "claude"))
    let sonnet = Contract.CapabilityChoice(id: "sonnet", name: "Sonnet")
    let standard = Contract.CapabilityChoice(id: "default", name: "Default")
    let options = Contract.CreationOptions(availability: .online, sessionId: "session-new",
      project: .init(id: "machine-1:local:p1", machineId: "machine-1", name: "App", rootPath: "/Users/dev/app"),
      agents: [.init(id: "agent-1", name: "Claude", machineId: "machine-1", machineName: "Studio", cliType: "builtin", agentType: "claude")],
      capabilities: [.init(machineId: "machine-1", cliType: "builtin", agentType: "claude", models: [sonnet], modes: [standard],
        legacyModes: [standard], reasoningEfforts: ["sonnet": ["low", "high"]], configOptions: [
          .select(.init(id: "model", name: "Model", category: "model", options: [sonnet], currentValue: "sonnet")),
          .boolean(.init(id: "fast", name: "Fast mode", options: [], currentValue: false)),
        ], steer: true)])
    let shareEntry = Contract.ShareEntry(shareId: "share-1", rootSessionId: "session-1", publisherUserId: "user-1",
      status: .active, revision: 2, credentialVersion: 1, selectedSourceIds: ["session-1"], canManage: true, canRevoke: true)
    let simulatorUdid = "00000000-0000-4000-8000-000000000001"
    let created = Contract.CreatedSession(id: "00000000-0000-4000-8000-000000000002", machineId: "machine-1", title: "Fix login",
      status: "idle", archived: false, pinned: false, projectId: "machine-1:local:p1", createdAt: "2026-10-24T00:00:00.000Z",
      cliType: "builtin", agentType: "claude")
    let editAttachments: [Contract.EditAttachment] = [
      .image(.init(editId: "original:0", fileName: "shot.png", mimeType: "image/png", sizeBytes: 2048, imageId: "image-1",
        width: 640, height: 480)),
      .file(.init(editId: "original:1", fileName: "notes.md", mimeType: "text/markdown", sizeBytes: 12, fileId: "file-1",
        sha256: "abc123", textPreview: true, transport: "r2", uploadedAt: 1_700_000_000_000)),
    ]
    XCTAssertEqual(decoded.map(\.gen), Array(repeating: 3, count: 95))
    XCTAssertEqual(decoded.map(\.message), [
      .result(id: "req-hello", .hello(.init(protocol: 1, methods: ["hello", "ensureSession"]))),
      .result(id: "req-ensure", .ensureSession(.init())),
      .error(id: "req-ensure", method: "ensureSession", .init(code: "session_not_ready", retryable: false)),
      .request(id: "req-grant", .grant(.init())),
      .event(.catalog(.init(catalog: #"{"projects":[]}"#, revision: 4))),
      .request(id: "req-shortcut", .shortcutCloud(.getStreamToken(.init(
        workspaceId: "workspace-1",
        args: .init(target: .index(.init(ownerUserId: "user-1", visibility: .workspace)), write: false)
      )))),
      .request(id: "req-github", .githubMentions(.init(workspaceId: "workspace-1", repoFullName: "lody/app"))),
      .request(id: "req-share", .shareRequest(.management(.init(
        workspaceId: "workspace-1",
        args: .list(.init(workspaceId: "workspace-1", cursor: nil))
      )))),
      .request(id: "req-share-revoke", .shareRequest(.api(.init(
        workspaceId: "workspace-1",
        args: .revoke(.init(args: .init(shareId: "share-1", expectedRevision: 2)))
      )))),
      .event(.shareProgress(.init(editorId: "ios-share-1", phase: .uploading, percent: 40))),
      .event(.machinePresence(.init(state: .live, onlineMachineIds: ["machine-1"]))),
      .event(.synced(.init(revision: 4, streams: 2))),
      .event(.syncError(.init(reason: .networkOrAuth, stream: "meta"))),
      .event(.sessionSubscriptions(.init(ids: ["session-1", "session-2"], reserved: ["session-2"]))),
      .event(.session(.init(sessionId: "session-1", session: #"{"v":1,"history":[]}"#, synced: true,
        backgroundWork: .init(id: "task-1", state: .receiving)))),
      .event(.sessionCache(.init(sessionId: "session-2", session: #"{"v":1,"history":[]}"#, synced: false))),
      .event(.sessionCache(.init(sessionId: "session-2", backgroundWork: .init(id: "task-2", state: .failed)))),
      .event(.diagnostic(.init(stage: "bootstrap_ok", stream: "meta"))),
      .result(id: "req-start", .start(.init())),
      .error(id: "req-start", method: "start", .init(code: "invalid_params", retryable: false, detail: "workspaceId: Too small")),
      .result(id: "req-restore", .restoreSessions(.init())),
      .result(id: "req-restore-none", .restoreSessions(.init())),
      .result(id: "req-active", .setActive(.init())),
      .result(id: "req-open", .openSession(.init())),
      .result(id: "req-close", .closeSession(.init())),
      .result(id: "req-release", .releaseReserve(.init())),
      .result(id: "req-ping", .ping(.init())),
      .result(id: "req-shortcuts", .promptShortcuts(.list(.init(entries: [entry])))),
      .result(id: "req-settings", .remoteSettings(.init(settings: [
        .init(kind: .mcp, id: "mcp-2", name: "Search", readOnly: false, detail: "stdio", enabledByDefault: true, configured: true),
      ]))),
      .result(id: "req-memory", .memorySettings(.init(
        machines: [.init(id: "machine-1", name: "Studio")], machineId: "machine-1",
        entries: [.init(machineId: "machine-1", providerId: "nowledge-mem", memoryId: "memory-1", name: "Work")],
        identities: [.init(id: "memory-1", name: "Work")], status: .ready, cached: false
      ))),
      .result(id: "req-roles", .agentRoles(.init(roles: [role], agents: [
        .init(id: "agent-1", name: "Claude", machineId: "machine-1", machineName: "Studio", cliType: "builtin", agentType: "claude"),
      ]))),
      .result(id: "req-shares", .publishedShares(.page(.init(
        workspaceId: "workspace-1", userId: "user-1", page: [share], isDone: false, continueCursor: "cursor-2"
      )))),
      .result(id: "req-mentions", .mentionCatalog(.init(items: [
        .init(path: "session-2", name: "Fix login", kind: .session, subtitle: "app", insertText: "@session:session-2"),
      ], truncated: false, incomplete: false))),
      .result(id: "req-shortcut-save", .promptShortcuts(.save(.init(entry: saved)))),
      .result(id: "req-shares-denied", .publishedShares(.failed(.init(error: "shares_forbidden")))),
      .error(id: "req-settings", method: "remoteSettings", .init(code: "setting_read_only", retryable: false)),
      .error(id: "req-memory", method: "memorySettings", .init(code: "memory_forbidden", retryable: false)),
      .error(id: "req-roles", method: "agentRoles", .init(code: "role_conflict", retryable: false)),
      .error(id: "req-shortcuts", method: "promptShortcuts", .init(code: "workspace_changed", retryable: false)),
      .error(id: "req-mentions", method: "mentionCatalog", .init(code: "metadata_not_ready", retryable: false)),
      .result(id: "req-options", .creationOptions(options)),
      .error(id: "req-options", method: "creationOptions", .init(code: "project_unavailable", retryable: false)),
      .result(id: "req-projects-browse", .localProjects(.directory(.init(path: "/Users/dev", parentPath: "/Users",
        entries: [.init(name: "app", absolutePath: "/Users/dev/app")], truncated: true, nextCursor: "cursor-2")))),
      .result(id: "req-projects-history", .localProjects(.history(.init(
        sessions: [.init(acpSessionId: "acp-1", title: "Fix login", importedSessionId: "session-9", status: .imported)],
        failures: [.init(acpSessionId: "acp-2", message: "missing transcript")])))),
      .result(id: "req-projects-targets", .localProjects(.targets(.init(targets: [target])))),
      .result(id: "req-projects-add", .localProjects(.project(.init(project: .init(id: "machine-1:local:p2",
        machineId: "machine-1", name: "Docs", rootPath: "/Users/dev/docs"))))),
      .error(id: "req-projects-browse", method: "localProjects", .init(code: "machine_unavailable", retryable: false)),
      .result(id: "req-sharing", .sessionSharing(.state(.init(entry: shareEntry, url: "https://share.lody.ai/s/share-1#secret",
        candidates: [.init(id: "session-1", title: "Launch notes")], selected: ["session-1"], pending: false)))),
      .result(id: "req-sharing-close", .sessionSharing(.closed(.init()))),
      .error(id: "req-sharing", method: "sessionSharing", .init(code: "share_busy", retryable: false)),
      .result(id: "req-preview", .sessionPreview(.init(url: "https://quiet-river.trycloudflare.com/?__lody_preview_token=synthetic"))),
      .result(id: "req-preview-denied", .sessionPreview(.init(error: "backend_rejected", status: 400))),
      .result(id: "req-simulator", .iosSimulatorControl(.init(type: "ios-simulator/control_response", sessionId: "session-1",
        success: true, preview: .init(operationId: "op-1", udid: simulatorUdid, phase: .booting, transport: .remote)))),
      .result(id: "req-simulator-old", .iosSimulatorControl(.init(error: "unsupported", capabilities: ["previewControl": 1]))),
      .error(id: "req-simulator", method: "iosSimulatorControl", .init(code: "metadata_not_ready", retryable: false)),
      .result(id: "req-item-detail", .itemDetail(.init(itemId: "tool-1", rev: 3, blocks: [
        .object(["type": .string("diff"), "path": .string("src/app.ts"), "oldText": .string("a\n"), "newText": .string("b\n")]),
        .object(["type": .string("terminal_output"), "output": .string("ok"),
          "exitStatus": .object(["exitCode": .number(0), "signal": .null])]),
      ], rawInput: .init(value: .object(["command": .string("ls")])), rawOutput: .init(value: .null),
        options: [.init(optionId: "allow", name: "Allow", kind: "allow_once")], truncated: true, nextCursor: "4"))),
      .error(id: "req-item-detail", method: "itemDetail", .init(code: "item_not_found", retryable: false)),
      .result(id: "req-turn-diff", .turnDiff(.ok(.init(base: .turn, path: "src/app.ts",
        old: .init(kind: .text, text: "a\n"), new: .init(kind: .missing, text: ""), add: 0, del: 1)))),
      .result(id: "req-file-diff", .fileDiff(.unavailable(.init(base: .current, path: "src/app.ts",
        reason: "not_tracked", message: "File is outside the repository")))),
      .result(id: "req-workspace-changes", .workspaceChanges(.ok(.init(base: "main", files: [
        .init(path: "README.md", add: 1, del: 0, kind: .modified), .init(path: "src/new.ts"),
      ])))),
      .result(id: "req-read-file", .readFile(.ok(.init(path: "README.md", kind: .text, text: "# Hello\n", bytes: 8)))),
      .result(id: "req-read-file-binary", .readFile(.ok(.init(path: "logo.png", kind: .binary, base64: "iVBORw0KGgo=",
        mimeType: "image/png", bytes: 8)))),
      .result(id: "req-read-file-missing", .readFile(.error(.init(path: "missing.md", code: "not_found")))),
      .result(id: "req-list-dir", .listDir(.init(entries: [.init(name: "components", type: .directory),
        .init(name: "app.ts", type: .file)], truncated: false))),
      .error(id: "req-list-dir", method: "listDir", .init(code: "project_unavailable", retryable: false)),
      .result(id: "req-create-session", .createSession(.created(.init(session: created)))),
      .result(id: "req-delete-session", .deleteSession(.init(sessionIds: ["session-1", "session-3"]))),
      .result(id: "req-archive-session", .archiveSession(.init())),
      .result(id: "req-pin-session", .pinSession(.init())),
      .result(id: "req-mark-read", .markSessionRead(.init())),
      .result(id: "req-rename-session", .renameSession(.init())),
      .result(id: "req-turn-quota", .checkTurnQuota(.notSent(.init(reason: .freeSessionTurnLimitReached)))),
      .result(id: "req-send-turn", .sendTurn(.accepted(.init(id: "00000000-0000-4000-8000-000000000003")))),
      .result(id: "req-edit-read", .editSession(.ready(.init(id: "turn-1", text: "Hello", attachments: editAttachments)))),
      .result(id: "req-edit-send", .editSession(.accepted(.init(id: "turn-2")))),
      .result(id: "req-control-turn", .controlTurn(.applied(.init()))),
      .result(id: "req-respond-permission", .respondPermission(.init(state: .accepted))),
      .result(id: "req-create-session-quota", .createSession(.rejected(.init(reason: .freeSessionLimitReached)))),
      .result(id: "req-create-session-lost", .createSession(.unknown(.init()))),
      .error(id: "req-delete-session", method: "deleteSession", .init(code: "metadata_not_ready", retryable: false)),
      .error(id: "req-rename-session", method: "renameSession", .init(code: "invalid_session", retryable: false)),
      .result(id: "req-turn-quota-allowed", .checkTurnQuota(.allowed(.init()))),
      .result(id: "req-send-turn-queued", .sendTurn(.queued(.init(id: "00000000-0000-4000-8000-000000000004")))),
      .result(id: "req-send-turn-guide", .sendTurn(.uploaded(.init(id: "00000000-0000-4000-8000-000000000005", awaitingGuide: true)))),
      .result(id: "req-send-turn-lost", .sendTurn(.unknown(.init(id: "00000000-0000-4000-8000-000000000006", reason: "ack_timeout")))),
      .result(id: "req-send-turn-quota", .sendTurn(.notSent(.init(reason: "free_session_turn_limit_reached")))),
      .result(id: "req-edit-stale", .editSession(.notSent(.init(reason: "message_no_longer_editable")))),
      .result(id: "req-edit-lost", .editSession(.unknown(.init()))),
      .result(id: "req-control-stop", .controlTurn(.stopped(.init()))),
      .result(id: "req-control-missed", .controlTurn(.notApplied(.init(reason: "unknown")))),
      .error(id: "req-control-turn", method: "controlTurn", .init(code: "stale_turn", retryable: false)),
      .result(id: "req-respond-stale", .respondPermission(.init(state: .stale))),
      .error(id: "req-respond-permission", method: "respondPermission", .init(code: "invalid_answers", retryable: false)),
      .result(id: "req-probe-schema", .probeSchema(.init(creationOptionsTrial: ["machine-1:local:p1": "ok agents=1 capabilities=1"],
        machines: ["machine-1": .init(otherKeys: ["agentConfig", "project"], capabilities: [.init(key: ["acpCapability", "agent-1"],
          cliType: .string("builtin"), agentType: .string("claude"),
          models: .array([.object(["id": .string("sonnet"), "name": .string("Sonnet")])]), configOptionFields: ["fast"])])]))),
      .error(id: "req-probe-schema", method: "probeSchema", .init(code: "metadata_not_ready", retryable: false)),
    ])
  }

  func testHostEnvelopesMatchFixtures() async throws {
    let expected = try fixtures("to-runtime")
    let replies = try fixtures("to-host")
    let harness = Harness(ids: [
      "req-hello", "req-ensure", "req-start", "req-restore", "req-restore-none",
      "req-active", "req-open", "req-close", "req-release", "req-ping",
      "req-shortcuts", "req-settings", "req-memory", "req-roles", "req-shares", "req-mentions", "req-shortcut-save",
      "req-options", "req-projects-browse", "req-projects-history", "req-sharing", "req-sharing-close",
      "req-preview", "req-simulator",
      "req-item-detail", "req-turn-diff", "req-file-diff", "req-workspace-changes", "req-read-file", "req-list-dir",
      "req-create-session", "req-delete-session", "req-archive-session", "req-pin-session", "req-mark-read",
      "req-rename-session", "req-turn-quota", "req-send-turn", "req-edit-read", "req-edit-send", "req-control-turn",
      "req-respond-permission", "req-probe-schema",
    ])
    let channel = channel(harness)

    let hello = Task { try await channel.call(Contract.Calls.Hello.self, .init(protocol: 1, gen: 3)) }
    await posted(harness, count: 1)
    XCTAssertEqual(try json(harness.posts[0]), try json(expected[0]))
    channel.receive(replies[0])
    let helloResult = try await hello.value
    XCTAssertEqual(helloResult.methods, ["hello", "ensureSession"])

    let ensure = Task { try await channel.call(Contract.Calls.EnsureSession.self, .init(sessionId: "session-1")) }
    await posted(harness, count: 2)
    XCTAssertEqual(try json(harness.posts[1]), try json(expected[1]))
    channel.receive(replies[1])
    _ = try await ensure.value

    channel.reply(Contract.HostCalls.Grant.self, id: "req-grant", .init(token: "synthetic", gatewayBaseUrl: "https://gateway.example", expiresIn: 3600))
    XCTAssertEqual(try json(harness.posts[2]), try json(expected[2]))
    channel.fail(id: "req-grant", method: "grant", code: "grant_failed", retryable: true)
    XCTAssertEqual(try json(harness.posts[3]), try json(expected[3]))

    channel.reply(Contract.HostCalls.ShortcutCloud.self, id: "req-shortcut", .init(value: .object([
      "token": .string("synthetic"), "expiresIn": .number(600),
      "gatewayBaseUrl": .string("https://gateway.example"), "streamId": .string("stream-1"),
    ])))
    channel.fail(id: "req-shortcut", method: Contract.HostCalls.ShortcutCloud.method, code: "shortcut_unavailable")
    channel.reply(Contract.HostCalls.GithubMentions.self, id: "req-github", .init(
      items: [.init(path: "issue:7", name: "Fix login", kind: .issue, subtitle: "lody/app #7", insertText: "#7")],
      truncated: false, incomplete: false
    ))
    channel.fail(id: "req-github", method: Contract.HostCalls.GithubMentions.method, code: "github_mentions_unavailable")
    channel.reply(Contract.HostCalls.ShareRequest.self, id: "req-share", .init(value: .object([
      "workspaceId": .string("workspace-1"), "userId": .string("user-1"), "page": .array([]),
      "isDone": .bool(true), "continueCursor": .string(""),
    ])))
    channel.reply(Contract.HostCalls.ShareRequest.self, id: "req-share-revoke", .init(value: .null))
    channel.fail(id: "req-share", method: Contract.HostCalls.ShareRequest.method, code: "share_request_failed")

    func roundTrip<C: RuntimeCall>(_ call: C.Type, _ params: C.Params, reply: Int) async throws {
      let count = harness.posts.count + 1
      let task = Task { try await channel.call(call, params) }
      await posted(harness, count: count)
      channel.receive(replies[reply])
      _ = try await task.value
    }
    try await roundTrip(Contract.Calls.Start.self, .init(workspaceId: "workspace-1", userId: "user-1", active: true), reply: 18)
    try await roundTrip(Contract.Calls.RestoreSessions.self, .init(ids: ["session-1", "session-2"], current: "session-1", reserved: ["session-2"]), reply: 20)
    try await roundTrip(Contract.Calls.RestoreSessions.self, .init(ids: [], current: nil, reserved: []), reply: 21)
    try await roundTrip(Contract.Calls.SetActive.self, .init(active: false), reply: 22)
    try await roundTrip(Contract.Calls.OpenSession.self, .init(sessionId: "session-1"), reply: 23)
    try await roundTrip(Contract.Calls.CloseSession.self, .init(), reply: 24)
    try await roundTrip(Contract.Calls.ReleaseReserve.self, .init(sessionId: "session-2"), reply: 25)
    try await roundTrip(Contract.Calls.Ping.self, .init(), reply: 26)
    let github = Contract.PromptShortcutProject.github(.init(repository: "lody/app"))
    let readme = Contract.PromptShortcutTarget.file(.init(project: github, path: "README.md"))
    let shortcut = Contract.PromptShortcut(v: 1, id: "shortcut-2", workspaceId: "workspace-1", ownerUserId: "user-1",
      visibility: .workspace, name: "Review", slug: "review", scope: .init(project: github), revision: "rev-2",
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, prompt: "Review @README.md",
      mentions: [.init(start: 7, end: 17, label: "@README.md", target: readme)])
    try await roundTrip(Contract.Calls.PromptShortcuts.self, .list(.init(workspaceId: "workspace-1", userId: "user-1")), reply: 27)
    try await roundTrip(Contract.Calls.RemoteSettings.self, .init(workspaceId: "workspace-1", userId: "user-1", kind: .mcp,
      remove: .init(kind: .mcp, id: "mcp-1", name: "Docs", readOnly: false, detail: "http", enabledByDefault: false,
        configured: true, updatedAt: 1_700_000_000_000)), reply: 28)
    try await roundTrip(Contract.Calls.MemorySettings.self, .`import`(.init(workspaceId: "workspace-1", userId: "user-1",
      machineId: "machine-1", memoryId: "memory-1")), reply: 29)
    try await roundTrip(Contract.Calls.AgentRoles.self, .save(.init(workspaceId: "workspace-1", userId: "user-1", id: "role-1",
      base: nil, fields: .init(name: "Reviewer", description: "", promptPrefix: "Review carefully", visibility: .workspace),
      target: .init(machineId: "machine-1", agentConfigId: "agent-1"))), reply: 30)
    try await roundTrip(Contract.Calls.PublishedShares.self, .list(.init(workspaceId: "workspace-1", userId: "user-1", cursor: "cursor-1")), reply: 31)
    try await roundTrip(Contract.Calls.MentionCatalog.self, .init(workspaceId: "workspace-1", userId: "user-1",
      category: .session, sessionId: "session-1"), reply: 32)
    try await roundTrip(Contract.Calls.PromptShortcuts.self, .save(.init(workspaceId: "workspace-1", userId: "user-1",
      entry: nil, value: shortcut, bodyDocId: "body-2")), reply: 33)
    try await roundTrip(Contract.Calls.CreationOptions.self, .init(workspaceId: "workspace-1", projectId: "machine-1:local:p1"), reply: 40)
    try await roundTrip(Contract.Calls.LocalProjects.self, .browse(.init(workspaceId: "workspace-1", browserId: "browser-1",
      userId: "user-1", machineId: "machine-1", path: "/Users/dev", cursor: "cursor-1")), reply: 42)
    let target = Contract.HistoryTarget(machineId: "machine-1", machineName: "Studio", localProjectId: "p1",
      projectName: "App", rootPath: "/Users/dev/app", provider: .init(cliType: .builtin, agentType: "claude"))
    try await roundTrip(Contract.Calls.LocalProjects.self, .history(.init(workspaceId: "workspace-1", browserId: "history-1",
      userId: "user-1", history: .`import`(.init(target: target, acpSessionIds: ["acp-1", "acp-2"])))), reply: 43)
    try await roundTrip(Contract.Calls.SessionSharing.self, .init(workspaceId: "workspace-1", sessionId: "session-1",
      editorId: "ios-share-1", action: .publish, selected: ["session-1"]), reply: 47)
    try await roundTrip(Contract.Calls.SessionSharing.self, .init(workspaceId: "workspace-1", sessionId: "session-1",
      editorId: "ios-share-1", action: .close), reply: 48)
    try await roundTrip(Contract.Calls.SessionPreview.self, .init(sessionId: "session-1", userId: "user-1", action: .create), reply: 50)
    try await roundTrip(Contract.Calls.IosSimulatorControl.self, .init(workspaceId: "workspace-1", sessionId: "session-1",
      userId: "user-1", command: .start(.init(udid: "00000000-0000-4000-8000-000000000001"))), reply: 52)
    try await roundTrip(Contract.Calls.ItemDetail.self, .init(sessionId: "session-1", entryId: "entry-1", itemId: "tool-1", cursor: "2"), reply: 55)
    try await roundTrip(Contract.Calls.TurnDiff.self, .init(sessionId: "session-1", entryId: "entry-1", path: "src/app.ts"), reply: 57)
    try await roundTrip(Contract.Calls.FileDiff.self, .init(sessionId: "session-1", path: "src/app.ts"), reply: 58)
    try await roundTrip(Contract.Calls.WorkspaceChanges.self, .init(sessionId: "session-1"), reply: 59)
    try await roundTrip(Contract.Calls.ReadFile.self, .init(sessionId: "session-1", path: "README.md"), reply: 60)
    try await roundTrip(Contract.Calls.ListDir.self, .init(workspaceId: "workspace-1", sessionId: "session-1",
      relativePath: "src", userId: "user-1"), reply: 63)
    let free = Contract.BillingEntitlement(effectivePlanTier: .free, checkoutPending: false)
    try await roundTrip(Contract.Calls.CreateSession.self, .init(workspaceId: "workspace-1", projectId: "machine-1:local:p1",
      sessionId: "00000000-0000-4000-8000-000000000002", machineId: "machine-1", agentConfigId: "agent-1", userId: "user-1",
      title: "Fix login", billingEntitlement: free), reply: 65)
    try await roundTrip(Contract.Calls.DeleteSession.self, .init(workspaceId: "workspace-1", sessionId: "session-1",
      sessionIds: ["session-1", "session-3"]), reply: 66)
    try await roundTrip(Contract.Calls.ArchiveSession.self, .init(workspaceId: "workspace-1", sessionId: "session-1", archived: true), reply: 67)
    try await roundTrip(Contract.Calls.PinSession.self, .init(workspaceId: "workspace-1", sessionId: "session-1", pinned: true), reply: 68)
    try await roundTrip(Contract.Calls.MarkSessionRead.self, .init(workspaceId: "workspace-1", sessionId: "session-1",
      lastReadAt: 1_700_000_000_000), reply: 69)
    try await roundTrip(Contract.Calls.RenameSession.self, .init(workspaceId: "workspace-1", sessionId: "session-1", title: "Renamed"), reply: 70)
    try await roundTrip(Contract.Calls.CheckTurnQuota.self, .init(sessionId: "session-1", billingEntitlement: nil), reply: 71)
    try await roundTrip(Contract.Calls.SendTurn.self, .init(sessionId: "session-1", id: "00000000-0000-4000-8000-000000000003",
      backgroundTaskId: "task-1", queue: false, guide: false, machineId: "machine-1", userId: "user-1", text: "Hello",
      attachmentBlocks: [["type": .string("image"), "imageId": .string("image-1"), "mimeType": .string("image/png"), "sizeBytes": .number(2048)]],
      cliType: "builtin", agentType: "claude", modelId: .init(value: nil), reasoningEffort: .init(value: "high"),
      reasoningEffortConfigId: "reasoning_effort", configOptionValues: ["fast": .bool(true)],
      billingEntitlement: .init(effectivePlanTier: .plus, checkoutPending: false)), reply: 72)
    try await roundTrip(Contract.Calls.EditSession.self, .read(.init(sessionId: "session-1", expectedUserTurnId: "turn-1",
      userId: "user-1", billingEntitlement: nil)), reply: 73)
    try await roundTrip(Contract.Calls.EditSession.self, .send(.init(sessionId: "session-1", expectedUserTurnId: "turn-1", id: "turn-2",
      userId: "user-1", billingEntitlement: free, backgroundTaskId: "task-2", text: "Edited", retainedIds: ["original:0"],
      attachmentBlocks: [])), reply: 74)
    try await roundTrip(Contract.Calls.ControlTurn.self, .init(action: .steer, sessionId: "session-1", machineId: "machine-1",
      turnId: "turn-3", messageId: "turn-4", interrupt: false), reply: 75)
    try await roundTrip(Contract.Calls.RespondPermission.self, .init(sessionId: "session-1", entryId: "entry-1", itemId: "tool-1",
      requestId: "permission-1", optionId: "submit", answers: [
        "Scope": .string("Repository"), "Checks": .array([.string("Lint"), .string("Tests")]),
      ]), reply: 76)
    try await roundTrip(Contract.Calls.ProbeSchema.self, .init(workspaceId: "workspace-1"), reply: 93)
    XCTAssertEqual(harness.posts.count, expected.count)
    for index in 4..<expected.count {
      XCTAssertEqual(try json(harness.posts[index]), try json(expected[index]))
    }
  }

  func testRuntimeErrorRejectsCallWithItsCode() async throws {
    let replies = try fixtures("to-host")
    let harness = Harness(ids: ["req-ensure"])
    let channel = channel(harness)
    let ensure = Task { try await channel.call(Contract.Calls.EnsureSession.self, .init(sessionId: "session-1")) }
    await posted(harness, count: 1)
    channel.receive(replies[2])
    do {
      _ = try await ensure.value
      XCTFail("expected failure")
    } catch let failure as RuntimeFailure {
      XCTAssertEqual(failure, RuntimeFailure(code: "session_not_ready"))
    }
  }

  func testTimeoutFailsCallAndIgnoresLateResult() async throws {
    let replies = try fixtures("to-host")
    let harness = Harness(ids: ["req-ensure"])
    let channel = channel(harness)
    let ensure = Task { try await channel.call(Contract.Calls.EnsureSession.self, .init(sessionId: "session-1")) }
    await posted(harness, count: 1)
    harness.timers.forEach { $0() }
    do {
      _ = try await ensure.value
      XCTFail("expected timeout")
    } catch let failure as RuntimeFailure {
      XCTAssertEqual(failure.code, "timeout")
      XCTAssertTrue(failure.retryable)
    }
    channel.receive(replies[1])
    XCTAssertEqual(channel.pendingCount, 0)
  }

  func testCloseFailsPendingCallsAndLaterCalls() async throws {
    let harness = Harness(ids: ["req-ensure"])
    let channel = channel(harness)
    let ensure = Task { try await channel.call(Contract.Calls.EnsureSession.self, .init(sessionId: "session-1")) }
    await posted(harness, count: 1)
    channel.close()
    for task in [ensure] {
      do {
        _ = try await task.value
        XCTFail("expected restart failure")
      } catch let failure as RuntimeFailure {
        XCTAssertEqual(failure, RuntimeFailure(code: "runtime_restarted", retryable: true))
      }
    }
    do {
      _ = try await channel.call(Contract.Calls.EnsureSession.self, .init(sessionId: "session-2"))
      XCTFail("expected closed channel")
    } catch let failure as RuntimeFailure {
      XCTAssertEqual(failure.code, "runtime_restarted")
    }
    XCTAssertEqual(harness.posts.count, 1)
  }

  func testStaleGenerationIsIgnored() async throws {
    let replies = try fixtures("to-host")
    let harness = Harness(ids: ["req-ensure"])
    let channel = channel(harness, generation: 4)
    let ensure = Task { try await channel.call(Contract.Calls.EnsureSession.self, .init(sessionId: "session-1")) }
    await posted(harness, count: 1)
    channel.receive(replies[1])
    XCTAssertEqual(channel.pendingCount, 1)
    ensure.cancel()
    channel.close()
  }

  func testHostRequestsAndEventsReachHandlers() throws {
    let replies = try fixtures("to-host")
    let harness = Harness()
    let channel = channel(harness)
    var requests: [String] = []
    var events: [Contract.Event] = []
    channel.onRequest = { id, request in requests.append("\(id):\(request.method)") }
    channel.onEvent = { events.append($0) }
    for index in 3..<replies.count { channel.receive(replies[index]) }
    XCTAssertEqual(requests, ["req-grant:grant", "req-shortcut:shortcutCloud", "req-github:githubMentions", "req-share:shareRequest", "req-share-revoke:shareRequest"])
    let expected = try replies.compactMap { text -> Contract.Event? in
      guard case .event(let event) = try JSONDecoder().decode(Contract.Envelope.self, from: Data(text.utf8)).message else { return nil }
      return event
    }
    XCTAssertEqual(expected.count, 10)
    XCTAssertEqual(events, expected)
  }

  func testMalformedAndUnknownRequestsAreAnsweredWithErrors() throws {
    let harness = Harness()
    let channel = channel(harness)
    channel.onRequest = { _, _ in XCTFail("malformed request reached the handler") }
    channel.receive(#"{"v":1,"gen":3,"kind":"request","id":"bad","method":"grant","payload":"nope"}"#)
    channel.receive(#"{"v":1,"gen":3,"kind":"request","id":"new","method":"futureMethod","payload":{}}"#)
    channel.receive(#"{"v":1,"gen":2,"kind":"request","id":"old","method":"grant","payload":{}}"#)
    channel.receive("not json")
    let errors = try harness.posts.map { try json($0) }
    XCTAssertEqual(errors.map { $0["id"] as? String }, ["bad", "new"])
    XCTAssertEqual(errors.map { ($0["error"] as? NSDictionary)?["code"] as? String }, ["invalid_params", "unsupported_method"])
  }

  func testOtherProtocolVersionAndMalformedErrorsSettleImmediately() async throws {
    let harness = Harness(ids: ["a", "b"])
    let channel = channel(harness)
    let first = Task { try await channel.call(Contract.Calls.EnsureSession.self, .init(sessionId: "s")) }
    await posted(harness, count: 1)
    let second = Task { try await channel.call(Contract.Calls.EnsureSession.self, .init(sessionId: "s")) }
    await posted(harness, count: 2)
    channel.receive(#"{"v":2,"gen":3,"kind":"error","id":"a","method":"ensureSession","error":{"code":"x"}}"#)
    channel.receive(#"{"v":1,"gen":3,"kind":"error","id":"b","method":"ensureSession","error":{"code":"x"}}"#)
    for (task, code) in [(first, "protocol_mismatch"), (second, "invalid_error")] {
      do {
        _ = try await task.value
        XCTFail("expected \(code)")
      } catch let failure as RuntimeFailure {
        XCTAssertEqual(failure.code, code)
      }
    }
    XCTAssertEqual(channel.pendingCount, 0)
  }
}
