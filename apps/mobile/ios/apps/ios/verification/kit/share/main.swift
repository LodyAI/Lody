import LodyCore
import Foundation

func check(_ condition: Bool, _ message: String) {
  if !condition { fatalError(message) }
}

let root = FileManager.default.temporaryDirectory.appendingPathComponent("lody-share-check-\(UUID().uuidString)")
ShareStore.useRoot(root)
defer { try? FileManager.default.removeItem(at: root) }

let project = CreateProject(id: "p1", machineId: "m1", name: "Alpha", rootPath: "/tmp/alpha")
let options = CreationOptions(sessionId: "cached", project: project, agents: [
  CreationAgent(id: "c", name: "Codex", machineId: "m1", machineName: "Mac", cliType: "builtin", agentType: "codex"),
], capabilities: [])

// Snapshot: catalog, options and prefs round-trip; nothing but catalog fields is stored.
try ShareStore.writeCatalog(#"{"userId":"u1","workspaceId":"w1","projects":[{"id":"p1","machineId":"m1","name":"Alpha","rootPath":"/tmp/alpha"}],"machineNames":{"m1":"Mac"},"token":"secret"}"#)
let catalogText = try String(contentsOf: root.appendingPathComponent("catalog.json"), encoding: .utf8)
check(!catalogText.contains("secret") && !catalogText.contains("token"), "unknown fields such as tokens are dropped")
check(ShareStore.catalog()?.projects == [project], "catalog round-trip")
try ShareStore.writeOptions(options, target: "p1")
try ShareStore.writeOptions(options, target: "chat")
check(ShareStore.options("p1") == options && ShareStore.options("chat") == options, "options round-trip")
check(ShareStore.optionsPath("github:o/r") == "options/github%3Ao%2Fr.json", "targets are file-safe")
try ShareStore.writePrefs(CreatePrefs(projectId: "p1", context: "project"))
check(ShareStore.prefs()?.projectId == "p1", "prefs round-trip")
let branches = CreateBranches(names: ["trunk", "feature/share"], defaultBranch: "trunk", nextPage: 2)
try ShareStore.writeBranches(branches, repo: "Owner/Repo", userId: "u1", workspaceId: "w1")
check(ShareStore.branches("Owner/Repo") == branches, "offline branch snapshot round-trips including incomplete state")
try ShareStore.writeBranches(CreateBranches(names: ["wrong-account"]), repo: "Owner/Repo", userId: "u2", workspaceId: "w1")
check(ShareStore.branches("Owner/Repo") == branches, "late branch responses cannot cross accounts")
try ShareStore.writeCatalog(#"{"userId":"u1","workspaceId":"w2","projects":[]}"#)
check(ShareStore.branches("Owner/Repo") == nil, "workspace switch clears branch snapshots")
check(ShareStore.options("p1") == nil, "switching workspace drops cached options")
check(ShareStore.prefs() == nil, "switching workspace drops remembered prefs")

// Inbox: entries queue in order, attachments are private copies, adopt lands in tmp.
let source = FileManager.default.temporaryDirectory.appendingPathComponent("share-source-\(UUID().uuidString).txt")
try Data("hello".utf8).write(to: source)
defer { try? FileManager.default.removeItem(at: source) }
func manifest(_ createdAt: Double, attachments: [ShareAttachment] = []) -> ShareManifest {
  ShareManifest(id: UUID().uuidString.lowercased(), createdAt: createdAt, userId: "u1", workspaceId: "w1",
    projectId: "p1", context: "project", text: "Look", attachments: attachments, draft: nil)
}
let later = manifest(2)
let first = manifest(1, attachments: [ShareAttachment(id: "a1", name: "../note.txt", uri: source.absoluteString, kind: "file")])
try ShareStore.enqueue(later, files: [])
try ShareStore.enqueue(first, files: [source])
check(ShareStore.pending().map(\.id) == [first.id, later.id], "inbox drains oldest first")
let stored = ShareStore.pending()[0].attachments[0]
check(!stored.uri.contains("/") && stored.uri.hasSuffix("-note.txt"), "stored attachment stays inside its entry")
let adopted = try ShareStore.adopt(first.id)
let adoptedURL = URL(string: adopted.attachments[0].uri)!
check(adoptedURL.path.hasPrefix(FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path)
  || adoptedURL.path.hasPrefix(FileManager.default.temporaryDirectory.path), "adopted attachment is in the app tmp")
check(try String(contentsOf: adoptedURL, encoding: .utf8) == "hello", "adopted content")
try? FileManager.default.removeItem(at: adoptedURL)
ShareStore.remove(first.id)
check(ShareStore.pending().map(\.id) == [later.id], "removed entry leaves the queue")

// Ids from outside are never paths.
check((try? ShareStore.adopt("../catalog")) == nil, "traversal id rejected")
ShareStore.remove("..")
check(FileManager.default.fileExists(atPath: root.path), "traversal remove ignored")
check((try? ShareStore.enqueue(ShareManifest(id: "../x", createdAt: 0, userId: "u1", workspaceId: "w1", context: "chat", text: "", attachments: []), files: [])) == nil,
  "enqueue refuses non-uuid ids")

// A failed attachment copy leaves no partial entry behind.
let broken = manifest(3, attachments: [ShareAttachment(id: "a2", name: "gone.txt", uri: "", kind: "file")])
check((try? ShareStore.enqueue(broken, files: [root.appendingPathComponent("missing.txt")])) == nil, "missing file fails")
check(!ShareStore.pending().contains { $0.id == broken.id }, "failed enqueue is rolled back")

ShareStore.clear()
check(ShareStore.catalog() == nil && ShareStore.pending().isEmpty, "logout clears snapshot and inbox")
print("PASS: share store")

// Offline application boundaries. The coordinator, sorting and App Group persistence
// below are production code; delivery/network/UI must never run in snapshot checks.
struct SessionListState {
  var key: String
  var userId: String
  var workspaceId: String
  var catalog: SessionCatalog
  var loading = true
  var connected = false
}
@MainActor final class SessionSource {
  static let live = SessionSource()
  var state = SessionListState(key: "", userId: "", workspaceId: "", catalog: SessionCatalog())
}
struct ShareCheckAccount {
  struct Identity { var id: String }
  var user: Identity
  var workspaces: [Identity]
}
@MainActor enum AuthSession {
  struct Snapshot { var account: ShareCheckAccount? }
  static var shared: AuthSession.Type { Self.self }
  static var snapshot = Snapshot()
}
@MainActor enum CatalogSession {
  static var shared: CatalogSession.Type { Self.self }
  static var selections: [String] = []
  static var onSelect: ((String) -> Void)?
  static func selectWorkspace(_ id: String) { selections.append(id); onSelect?(id) }
}
@MainActor final class LodyPageController { var onClose: (() -> Void)? }
@MainActor enum LodyShell {
  static var shared: LodyShell.Type { Self.self }
  static func close(from: LodyPageController) { fatalError("Unexpected form") }
  static var onOpen: ((String) -> Void)?
  static func openSessionFromExternal(_ id: String) { onOpen?(id) }
}
@MainActor enum SessionNavigation {
  static func handle(_ name: String, _ fields: [String: Any]) throws -> LodyPageController? { fatalError("Unexpected form") }
}
@MainActor enum CreateSessionService {
  static var live: CreateSessionService.Type { Self.self }
  static var response: CreationOptions?
  static func options(_ workspace: String, _ project: String?) async throws -> CreationOptions {
    guard let response else { fatalError("Unexpected network") }
    return response
  }
}
@MainActor enum OutboxSession {
  static var shared: OutboxSession.Type { Self.self }
  static func put(user: String, workspace: String, json: String) throws -> Task<Void, Error> {
    guard let record = OutboxRecord.decode(json) else { fatalError("Invalid delivered draft") }
    return Task {
      let file = root.appendingPathComponent("delivered-" + record.sessionId + ".json")
      try Data(json.utf8).write(to: file, options: .atomic)
    }
  }
}
@MainActor enum LodyToastOverlay {
  enum Kind { case error }
  static var shared: LodyToastOverlay.Type { Self.self }
  static var messages: [String] = []
  static func show(message: String, kind: Kind) { messages.append(message) }
}
@MainActor enum DiagnosticsStore {
  static var shared: DiagnosticsStore.Type { Self.self }
  static func record(_ category: String, _ event: String, fields: [String: String]) {}
}

let savedSort = UserDefaults.standard.object(forKey: "inboxProjectSort")
defer {
  if let savedSort { UserDefaults.standard.set(savedSort, forKey: "inboxProjectSort") }
  else { UserDefaults.standard.removeObject(forKey: "inboxProjectSort") }
}
let coordinator = NativeShareCoordinator()
var shareMode: WorkspaceContentMode = .plaintext
coordinator.workspaceMode = { _ in shareMode }
defer { coordinator.stop() }
SessionSource.live.state = SessionListState(key: "u1:w1", userId: "u1", workspaceId: "w1", catalog: SessionCatalog(
  projects: [SessionProject(id: "p1", name: "Alpha"), SessionProject(id: "p2", name: "Beta")],
  sessions: [SessionItem(id: "s1", projectId: "p1", lastMessageAt: 10), SessionItem(id: "s2", projectId: "p2", lastMessageAt: 20)],
  machineNames: ["m1": "Mac"]
))
UserDefaults.standard.set(InboxSort.allCases.firstIndex(of: .name)!, forKey: "inboxProjectSort")
coordinator.reconcile()
check(ShareStore.catalog()?.projects.map(\.id) == ["p1", "p2"], "coordinator persists name order")
// A connection-only delivery may reuse the projection and must keep its disk result.
SessionSource.live.state.connected = true
coordinator.reconcile()
check(ShareStore.catalog()?.machineNames == ["m1": "Mac"], "connection refresh preserves catalog")
UserDefaults.standard.set(InboxSort.allCases.firstIndex(of: .activity)!, forKey: "inboxProjectSort")
coordinator.reconcile()
check(ShareStore.catalog()?.projects.map(\.id) == ["p2", "p1"], "sort-only change updates persisted order")
SessionSource.live.state.catalog.sessions[0].lastMessageAt = 30
coordinator.reconcile()
check(ShareStore.catalog()?.projects.map(\.id) == ["p1", "p2"], "activity change invalidates projection")
UserDefaults.standard.set(InboxSort.allCases.firstIndex(of: .urgency)!, forKey: "inboxProjectSort")
coordinator.reconcile()
check(ShareStore.catalog()?.projects.map(\.id) == ["p1", "p2"], "equal urgency falls back to activity")
SessionSource.live.state.catalog.sessions[1].status = "waiting"
coordinator.reconcile()
check(ShareStore.catalog()?.projects.map(\.id) == ["p2", "p1"], "status change updates urgency order")
SessionSource.live.state.catalog.sessions[1].archived = true
coordinator.reconcile()
check(ShareStore.catalog()?.projects.map(\.id) == ["p1", "p2"], "archive removes urgency contribution")
SessionSource.live.state.catalog.machineNames["m1"] = "Renamed Mac"
coordinator.reconcile()
check(ShareStore.catalog()?.machineNames?["m1"] == "Renamed Mac", "machine label changes reach extension")
try ShareStore.writeOptions(options, target: "p1")
try ShareStore.writePrefs(CreatePrefs(projectId: "p1", context: "project"))
SessionSource.live.state.key = "u1:w2"
SessionSource.live.state.workspaceId = "w2"
coordinator.reconcile()
check(ShareStore.catalog()?.workspaceId == "w2" && ShareStore.options("p1") == nil && ShareStore.prefs() == nil,
  "workspace switch persists new identity and clears old scoped choices")
SessionSource.live.state.key = "u2:w2"
SessionSource.live.state.userId = "u2"
coordinator.reconcile()
check(ShareStore.catalog()?.userId == "u2", "account switch cannot reuse previous account snapshot")

// Fail the actual atomic write, then recover without changing projection inputs.
let catalogFile = root.appendingPathComponent("catalog.json")
try FileManager.default.removeItem(at: catalogFile)
try FileManager.default.createDirectory(at: catalogFile, withIntermediateDirectories: false)
try Data("block replacement".utf8).write(to: catalogFile.appendingPathComponent("blocker"))
SessionSource.live.state.catalog.projects[0].name = "Updated Alpha"
coordinator.reconcile()
check(ShareStore.catalog() == nil, "failed write must not claim a persisted catalog")
coordinator.reconcile()
check(ShareStore.catalog() == nil, "persistent failure remains recoverable")
try FileManager.default.removeItem(at: catalogFile)
coordinator.reconcile()
check(ShareStore.catalog()?.projects.first?.name == "Updated Alpha", "identical projection retries after failed persistence")

// Stop is the logout/reset boundary; an equal next snapshot must be persisted anew.
coordinator.stop()
ShareStore.clear()
coordinator.reconcile()
check(ShareStore.catalog()?.userId == "u2", "stop allows the same scope to restore its cleared persisted catalog")
coordinator.stop()
shareMode = .e2ee
coordinator.reconcile()
check(ShareStore.catalog() == nil, "Encrypted workspaces cannot export an extension catalog")
shareMode = .unknown
coordinator.reconcile()
check(ShareStore.catalog() == nil, "Unknown workspaces cannot export an extension catalog")
print("PASS: production share coordinator scope, sorting, status, archive, labels, persistence retry, reset and encrypted/unknown exclusion")

// Drive the real pending manifests, routing, draft construction and disk delivery.
// Complete on either navigation outcome, so an accidental switch fails without sleeps.
ShareStore.clear()
let queueCoordinator = NativeShareCoordinator()
defer { queueCoordinator.stop() }
var modes: [String: WorkspaceContentMode] = ["waiting": .unknown, "encrypted": .e2ee, "plain": .plaintext]
queueCoordinator.workspaceMode = { modes[$0] ?? .unknown }
AuthSession.snapshot = .init(account: ShareCheckAccount(user: .init(id: "share-user"), workspaces: ["waiting", "encrypted", "plain"].map { .init(id: $0) }))
SessionSource.live.state = SessionListState(key: "share-user:plain", userId: "share-user", workspaceId: "plain", catalog: SessionCatalog(), loading: false, connected: false)
CreateSessionService.response = options
func queued(_ workspace: String, time: Double, user: String = "share-user") -> ShareManifest {
  let draft = CreateSessionDraft(sessionId: "session-" + workspace, userId: user, workspaceId: workspace,
    projectId: "p1", projectName: "Alpha", agent: options.agents[0], choice: ModelChoice())
  return ShareManifest(id: UUID().uuidString.lowercased(), createdAt: time, userId: user, workspaceId: workspace,
    projectId: "p1", context: "project", text: "Share to " + workspace, attachments: [], draft: draft)
}
let foreign = queued("encrypted", time: 0, user: "different-account")
let unknown = queued("waiting", time: 1)
let encrypted = queued("encrypted", time: 2)
let plain = queued("plain", time: 3)
for entry in [foreign, unknown, encrypted, plain] { try ShareStore.enqueue(entry, files: []) }
CatalogSession.selections = []
LodyToastOverlay.messages = []
let firstOutcome = await withCheckedContinuation { (done: CheckedContinuation<String, Never>) in
  CatalogSession.onSelect = { done.resume(returning: "switched:" + $0) }
  LodyShell.onOpen = { done.resume(returning: "delivered:" + $0) }
  queueCoordinator.reconcile()
}
queueCoordinator.stop()
CatalogSession.onSelect = nil; LodyShell.onOpen = nil
check(firstOutcome == "delivered:session-plain", "Blocked entries must not route away before a later plaintext entry is delivered: " + firstOutcome)
check(CatalogSession.selections.isEmpty && SessionSource.live.state.workspaceId == "plain", "The current plaintext workspace remains selected")
check(ShareStore.pending().map(\.id) == [unknown.id], "Unknown stays durable; encrypted, foreign-account and delivered plaintext entries leave the queue")
check(!FileManager.default.fileExists(atPath: root.appendingPathComponent("inbox/" + encrypted.id).path), "Removing encrypted manifests also clears their captured attachments")
let delivered = OutboxRecord.decode(try String(contentsOf: root.appendingPathComponent("delivered-session-plain.json"), encoding: .utf8))
check(delivered?.send["text"] == .string("Share to plain"), "The later ordinary share reaches the native outbox persistence port")
check(LodyToastOverlay.messages.count == 1, "Only the owned encrypted entry reports unsupported delivery")
print("PASS: unknown and encrypted Share entries cannot switch away from plaintext or block later delivery; unknown stays queued and encrypted is removed")

// Once classification succeeds, the retained unknown entry may route and deliver normally.
modes["waiting"] = .plaintext
let retryOutcome = await withCheckedContinuation { (done: CheckedContinuation<String, Never>) in
  CatalogSession.onSelect = { id in
    SessionSource.live.state.workspaceId = id
    SessionSource.live.state.key = "share-user:" + id
  }
  LodyShell.onOpen = { done.resume(returning: $0) }
  queueCoordinator.wake()
}
queueCoordinator.stop()
CatalogSession.onSelect = nil; LodyShell.onOpen = nil
check(retryOutcome == "session-waiting" && ShareStore.pending().isEmpty, "Confirmed plaintext admission releases the retained share")
check(CatalogSession.selections == ["waiting"], "Only a now-admitted workspace can trigger an automatic switch")
print("PASS: a retained unknown Share entry delivers after explicit plaintext classification")
