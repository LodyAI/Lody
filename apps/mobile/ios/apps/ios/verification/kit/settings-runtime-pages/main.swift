import Foundation

let review = MemoryAssociation(machineId: "studio", providerId: "nowledge-mem", memoryId: "review", name: "Reviewer",
                               description: "Code review preferences")
let deleted = MemoryAssociation(machineId: "studio", providerId: "nowledge-mem", memoryId: "deleted", name: "Previous identity")
let memory = MemorySnapshot(
  machines: [MemoryMachine(id: "studio", name: "Studio"), MemoryMachine(id: "laptop", name: "Laptop")], machineId: "studio",
  entries: [review, deleted], identities: [MemoryIdentity(id: "review", name: "Reviewer"), MemoryIdentity(id: "new", name: "")],
  status: "ready", cached: false
)
precondition(MemorySections.entryId(review) == #"["nowledge-mem","review"]"#, "Saved ids match JSON.stringify")
precondition(MemorySections.entryId(MemoryAssociation(machineId: "m", providerId: "a/b", memoryId: "é", name: "")) == #"["a/b","é"]"#)
precondition(MemorySections.source(memory) == "Studio")
var sourceless = memory
sourceless.machines = []
precondition(MemorySections.source(sourceless) == "studio")
precondition(MemorySections.missing(memory, deleted) && !MemorySections.missing(memory, review))
var offline = memory
offline.status = "offline"
precondition(!MemorySections.missing(offline, deleted), "Only a ready inventory proves an identity is missing")

let sections = MemorySections.list(memory, loading: false, failed: false, uncertain: false)
precondition(sections.map(\.id) == ["machines", "provider", "saved", "available"])
precondition(sections[0].rows.map(\.id) == ["machine:studio", "machine:laptop"] && sections[0].rows[0].selected)
let saved = sections[2].rows
precondition(saved.map(\.id) == [#"saved:["nowledge-mem","review"]"#, #"saved:["nowledge-mem","deleted"]"#])
precondition(saved[1].subtitle == "Studio · nowledge-mem · deleted · settings.memory.missing", saved[1].subtitle)
precondition(saved.allSatisfy { $0.navigates && $0.action })
let available = sections[3].rows
precondition(available[0].subtitle == "review · settings.memory.imported" && !available[0].action, "Linked identities cannot be imported twice")
precondition(available[1].title == "new" && available[1].action)
precondition(MemorySections.list(memory, loading: false, failed: false, uncertain: true)[3].rows.allSatisfy { !$0.action })
var cached = memory
cached.cached = true
precondition(!MemorySections.list(cached, loading: false, failed: false, uncertain: false).map(\.id).contains("available"))
var missingProvider = memory
missingProvider.status = "not_installed"
let install = MemorySections.list(missingProvider, loading: false, failed: false, uncertain: false)[1].rows
precondition(install.map(\.id) == ["provider-status", "provider-install"])
var noMachine = memory
noMachine.machineId = nil
precondition(MemorySections.list(noMachine, loading: false, failed: false, uncertain: false).map(\.id) == ["machines"])
precondition(MemorySections.list(nil, loading: false, failed: false, uncertain: false).isEmpty)

let detail = MemorySections.detail(review, snapshot: memory, busy: false, uncertain: false)
precondition(detail[0].rows.map(\.id) == ["memory-name", "memory-id", "memory-source", "memory-provider", "memory-status"])
precondition(detail[0].rows[2].title == "Studio" && detail[0].rows[2].subtitle == "studio")
precondition(detail[1].rows[0].destructive && detail[1].rows[0].action)
precondition(!MemorySections.detail(review, snapshot: cached, busy: false, uncertain: false)[1].rows[0].action)
precondition(!MemorySections.detail(review, snapshot: memory, busy: false, uncertain: true)[1].rows[0].action)
let foreign = MemoryAssociation(machineId: "m", providerId: "future-provider", memoryId: "future", name: "Other")
precondition(MemorySections.detail(foreign, snapshot: memory, busy: false, uncertain: false)[0].rows[4].title == "settings.memory.unverifiedProvider")

struct Failure: Error, CustomStringConvertible { let description: String }
precondition(MemoryFailure(Failure(description: "memory_forbidden")) == MemoryFailure(text: "settings.memory.forbidden"))
precondition(MemoryFailure(Failure(description: "memory_not_running")) == MemoryFailure(text: "settings.memory.status.not_running", status: "not_running"))
precondition(MemoryFailure(Failure(description: "memory_conflict")).text == "settings.remote.conflict")
let unknown = MemoryFailure(Failure(description: "memory_write_unknown"))
precondition(unknown.uncertain && unknown.status == nil, "write_unknown is never mistaken for the unknown provider status")
let wrapped = NSError(domain: "LodyKit.DataRuntime", code: 1, userInfo: [NSLocalizedDescriptionKey: "command_failed: memory_offline"])
precondition(MemoryFailure(wrapped).status == "offline")
let request = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(MemoryRequest(workspaceId: "w", action: "list"))) as! [String: String]
precondition(request == ["workspaceId": "w", "action": "list"], "Memory request must encode the expected fields")

func share(_ id: String, publisher: String = "me", status: String = "active", link: Bool = true, revoke: Bool = true) -> PublishedShare {
  PublishedShare(shareId: id, rootSessionId: "source", publisherUserId: publisher, status: status, title: id == "untitled" ? "" : "Title",
                 revision: 1, credentialVersion: 1, createdAt: 0, updatedAt: 0, totalBytes: 1500, conversationCount: 2,
                 canManage: true, canRevoke: revoke, hasLocalLink: link)
}
let page = PublishedSharePage(workspaceId: "w", userId: "me", page: [share("own"), share("untitled")], isDone: false, continueCursor: "c")
let shares = PublishedSharesSections.list(page, pages: 1, busy: false, failed: false)
precondition(shares.map(\.id) == ["shares", "pagination", "static"])
precondition(shares[0].rows.map(\.id) == ["share:own", "share:untitled"] && shares[0].rows[1].title == "settings.shares.untitled")
precondition(shares[0].rows[0].subtitle.hasPrefix("settings.shares.status.active · me · "))
precondition(shares[1].rows.map(\.id) == ["shares-next"], "First page offers only Next")
precondition(PublishedSharesSections.list(page, pages: 2, busy: false, failed: false)[1].rows.map(\.id) == ["shares-previous", "shares-next"])
precondition(!PublishedSharesSections.list(page, pages: 1, busy: false, failed: true)[0].rows[0].action)
var last = page
last.isDone = true
last.page = []
let empty = PublishedSharesSections.list(last, pages: 1, busy: false, failed: false)
precondition(empty.map(\.id) == ["shares", "static"] && empty[0].rows.map(\.id) == ["shares-empty"])

let own = PublishedSharesSections.detail(share("own"), actor: "me", busy: false, blocked: false)
precondition(own.map(\.id) == ["details", "link", "revoke"] && own[1].rows.map(\.id) == ["share-open", "share-copy"])
let blocked = PublishedSharesSections.detail(share("own"), actor: "me", busy: false, blocked: true)
precondition(blocked[0].rows[1].subtitle == "settings.shares.lastConfirmed" && blocked[1].rows.allSatisfy { !$0.action })
let missingLink = PublishedSharesSections.detail(share("own", link: false), actor: "me", busy: false, blocked: false)
precondition(missingLink[1].rows.isEmpty && missingLink[1].footer == "settings.shares.linkMissing")
let teammate = PublishedSharesSections.detail(share("t", publisher: "teammate", link: false), actor: "me", busy: false, blocked: false)
precondition(teammate[1].footer == "settings.shares.linkOtherPublisher")
let revoked = PublishedSharesSections.detail(share("r", status: "revoked"), actor: "me", busy: false, blocked: false)
precondition(revoked.map(\.id) == ["details", "link"] && revoked[1].footer == "settings.shares.linkRevoked" && revoked[1].rows.isEmpty)
precondition(PublishedSharesSections.detail(share("o", revoke: false), actor: "me", busy: false, blocked: false).count == 2)

precondition(PublishedSharesSections.errorText(Failure(description: "shares_conflict")) == "settings.shares.error.conflict")
precondition(PublishedSharesSections.errorText(Failure(description: "offline")) == "settings.shares.error.unavailable")
precondition(page.valid)
var bad = page
bad.page[0].shareId = "bad id"
precondition(!bad.valid)
bad = page
bad.page[0].credentialVersion = 0
precondition(!bad.valid)
let list = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(PublishedSharesRequest.list("w", cursor: nil))) as! [String: String]
precondition(list == ["workspaceId": "w", "action": "list"])

print("PASS: memory sections, failure mapping, published share sections, paging and validation")
