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
