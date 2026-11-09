import Foundation

let hour = 3_600_000.0
let now = Date().timeIntervalSince1970 * 1000

// A family belongs exclusively to its parent's bucket, even across projects and dates. Tabs
// (`parentSessionId`) belong to their conversation and never list (web `sessionListAtom`).
var bucketParent = SessionItem(id: "bucket-parent", projectId: "p")
bucketParent.createdAt = Date(timeIntervalSince1970: (now - 3 * 86_400_000) / 1000).ISO8601Format()
var bucketChild = SessionItem(id: "bucket-child", projectId: "other", openedBySessionId: "bucket-parent")
bucketChild.status = "running"
bucketChild.createdAt = Date().ISO8601Format()
var bucketTab = SessionItem(id: "bucket-tab", projectId: "other")
bucketTab.parentSessionId = "bucket-parent"
bucketTab.status = "waiting"
bucketTab.createdAt = Date().ISO8601Format()
let bucketCatalog = SessionCatalog(sessions: [bucketChild, bucketTab, bucketParent])
for grouping in [HomeGrouping.time, .status, .project] {
  let sections = InboxSections.home(bucketCatalog, grouping: grouping, now: now)
  precondition(sections.count == 1, "Children must never create their own bucket")
  precondition(sections[0].rows.map(\.id) == ["bucket-parent", "bucket-child"], "Tabs never list")
  precondition(sections[0].rows.map(\.parentId) == ["", "bucket-parent"])
}
precondition(InboxSections.home(bucketCatalog, grouping: .time, now: now)[0].id == "week")
precondition(InboxSections.home(bucketCatalog, grouping: .status, now: now)[0].id == "attention")

var pinnedParent = bucketParent
pinnedParent.pinned = true
let pinnedCatalog = SessionCatalog(sessions: [bucketChild, bucketTab, pinnedParent, SessionItem(id: "ordinary", projectId: "p")])
for grouping in [HomeGrouping.time, .status, .project] {
  let sections = InboxSections.home(pinnedCatalog, grouping: grouping, now: now)
  precondition(sections.first?.id == "pinned", "Pin group leads every view")
  precondition(sections[0].rows.map(\.id) == ["bucket-parent", "bucket-child"], "Pinned families stay together")
  precondition(sections.flatMap(\.rows).filter { $0.id == "bucket-parent" }.count == 1)
}

var archivedPin = pinnedParent
archivedPin.id = "archived-pin"
archivedPin.archived = true
var hiddenPin = bucketTab
hiddenPin.pinned = true
precondition(InboxSections.home(SessionCatalog(sessions: [archivedPin, hiddenPin, bucketParent]), grouping: .time).allSatisfy { $0.id != "pinned" })
var ownedPin = pinnedParent
ownedPin.userId = "other"
var mine = SessionItem(id: "mine", projectId: "p")
mine.userId = "me"
precondition(InboxSections.home(SessionCatalog(sessions: [ownedPin, mine]), grouping: .time, owner: "me").flatMap(\.rows).map(\.id) == ["mine"])

let saved = """
{"catalog":{"projects":[{"id":"p","name":"Lody","rootPath":"/Users/me/lody","machineId":"m"},{"broken":true}],
"machineIds":["m"],"sessions":[
{"id":"root","title":"Root","status":"completed","archived":true,"pinned":false,"projectId":"p","createdAt":"2026-01-02T03:04:05.678Z","lastMessageAt":\(now - 120_000),"lastReadAt":\(now - hour),"branchName":"main","lastModel":{"name":"","modelId":"gpt-5"},"diff":{"add":3,"del":1}},
{"id":"child","title":"Child","status":"error","archived":true,"pinned":false,"projectId":"p","createdAt":"2026-01-02T03:04:05Z","openedBySessionId":"root","lastModel":null},
{"id":"tab","title":"Tab","status":"running","archived":true,"pinned":false,"projectId":"p","createdAt":"2026-01-02T03:04:05Z","parentSessionId":"root"},
{"id":"chat","title":"Chat","status":"waiting","archived":false,"pinned":true,"projectId":"w:unassigned","createdAt":"2026-01-02T03:04:05Z","awaitingUserSince":1,"branchName":""},
{"title":"missing id"}
]}}
"""
guard let catalog = SessionCatalog.decode(saved: Data(saved.utf8)) else { fatalError("Catalog must decode") }
precondition(catalog.projects.map(\.id) == ["p"], "Malformed projects are dropped")
precondition(catalog.machineIds == ["m"] && catalog.machineNames.isEmpty)
precondition(catalog.sessions.map(\.id) == ["root", "child", "tab", "chat"], "Malformed sessions are dropped")
precondition(SessionCatalog.decode(saved: Data(#"{"catalog":{"projects":[],"sessions":[]}}"#.utf8)) == nil, "Incomplete catalogs are rejected")

let root = catalog.sessions[0], child = catalog.sessions[1], tab = catalog.sessions[2], chat = catalog.sessions[3]
precondition(child.modelNeverRan && !root.modelNeverRan && root.modelName == "gpt-5")
precondition(chat.branchName == nil, "Empty branch names behave like JS falsy values")
precondition(child.activityAt == 1_767_323_045_000 && root.lastMessageAt == root.activityAt)

precondition(SessionState(root) == .archived && SessionState(chat) == .attention)
var live = chat
live.status = "running"
precondition(SessionState(live) == .live, "Awaiting input never hides a live run")

let row = SessionRows.row(root, projectName: "Lody", now: now)
precondition(row.subtitle == "Lody · main" && row.subtitleMono && row.modelName == "gpt-5")
precondition(row.value == "time.compact.minutes" && row.accessibilityValue == "time.minutesAgo", "Rows draw a compact time and speak the full one")
precondition(row.unread && row.badge == "inbox.badge.archived" && row.imageTint.isEmpty)
precondition(row.actions.map(\.id) == ["read", "archive"] && row.actions[1].title == "session.action.unarchive")
precondition(row.leadingActions.map(\.id) == ["pin"] && row.leadingActions[0].tint == "yellow")
precondition(row.menuActions.map(\.id) == ["rename", "pin", "archive", "share", "delete"] && row.menuActions[4].destructive)
precondition(row.preview == "session" && row.navigates && row.action && row.diff == ["add": 3, "del": 1])
precondition(SessionRows.row(child).modelName == "session.notRun")
var viewed = root
viewed.lastViewedMessageAt = root.lastMessageAt
precondition(!SessionRows.row(viewed).unread && SessionRows.isUnread(viewed), "A local view clears emphasis without changing the server watermark")
precondition(SessionRows.row(viewed).actions.map(\.id) == ["archive"], "Viewed output must not offer Mark Read")
var laterOutput = viewed
laterOutput.lastMessageAt = (viewed.lastMessageAt ?? 0) + 1
precondition(SessionRows.row(laterOutput).unread)
precondition(SessionRows.row(laterOutput).actions.map(\.id) == ["read", "archive"], "New output restores Mark Read")
laterOutput.lastReadAt = laterOutput.lastMessageAt
precondition(!SessionRows.row(laterOutput).unread)
precondition(SessionRows.row(laterOutput).actions.map(\.id) == ["archive"], "Remote read removes Mark Read")
let chatRow = SessionRows.row(chat)
precondition(chatRow.badge == "inbox.badge.attention" && chatRow.imageTint == "warning" && chatRow.subtitle.isEmpty)

let archived = catalog.sessions.filter(\.archived).sorted(by: SessionRows.byActivity)
precondition(archived.map(\.id) == ["root", "child", "tab"])
let rows = SessionRows.treeRows(archived, all: catalog.sessions) { SessionRows.row($0, now: now) }
precondition(rows.map(\.id) == ["root", "child"], "Opened sessions nest under their opener; contained tabs never list")
// Parent and hidden children retain separate states.
var failedParent = SessionItem(id: "family-parent", projectId: "p")
failedParent.status = "error"
var runningChild = SessionItem(id: "family-child", projectId: "p", openedBySessionId: "family-parent")
runningChild.status = "running"
let family = [failedParent, runningChild]
let familyRows = SessionRows.treeRows(family, all: family) { SessionRows.row($0, now: now) }
precondition(familyRows[0].imageTint == "danger", "Parent keeps its own state")
precondition(familyRows[0].collapsedImageTint == "blue", "Collapsed summary uses children only")
var foldedRow = rows[0]
foldedRow.value = "1h"
foldedRow.collapsedBadge = "attention"
let shownFolded = foldedRow.displayingCollapsed(true, keepingTime: true)
precondition(shownFolded.value == "1h" && shownFolded.badge == "attention", "A folded parent keeps its time and takes its children's state")
precondition(foldedRow.displayingCollapsed(true).value == "inbox.session.children", "Compact hosts still show the count in the time column")
precondition(rows[0].collapsedValue == "inbox.session.children" && rows[1].parentId == "root")
precondition(rows[0].collapsedBadge == "inbox.badge.archived")
precondition(rows.map(\.lastChild) == [false, true], "Only the final opened session closes the rail")
var second = SessionItem(id: "second", projectId: "p", openedBySessionId: "root")
second.lastMessageAt = 1
second.archived = true
let pair = SessionRows.treeRows([root, child, second], all: [root, child, second]) { SessionRows.row($0, now: now) }
precondition(pair.map(\.id) == ["root", "child", "second"] && pair.map(\.lastChild) == [false, false, true],
             "Earlier siblings keep the trunk running to the last child")
precondition(SessionRows.treeRows(archived, all: catalog.sessions, maxRoots: 1) { SessionRows.row($0) }.count == 2)

var cycleA = SessionItem(id: "a", projectId: "p", openedBySessionId: "b")
var cycleB = SessionItem(id: "b", projectId: "p", openedBySessionId: "a")
cycleA.lastMessageAt = 2
cycleB.lastMessageAt = 1
precondition(SessionRows.tree([cycleA, cycleB], all: [cycleA, cycleB]).count == 2, "Opener cycles terminate as separate entries")
precondition(SessionRows.tree([cycleA], all: [cycleA, cycleB]).count == 1, "Hidden openers do not group")

var pinned = SessionItem(id: "pinned", pinned: true, lastMessageAt: 1)
let recent = SessionItem(id: "recent", lastMessageAt: 5)
precondition([recent, pinned].sorted(by: SessionRows.byActivity).map(\.id) == ["pinned", "recent"])
pinned.pinned = false
precondition([pinned, recent].sorted(by: SessionRows.byActivity).map(\.id) == ["recent", "pinned"])

precondition(SessionRows.deletionTargets(catalog.sessions, id: "root").map(\.id) == ["root", "tab"])
precondition(!SessionRows.deletionBlocked([root, child]) && SessionRows.deletionBlocked([live]))
precondition(SessionRows.projectId(ofRow: "toggle:p") == "p" && SessionRows.projectId(ofRow: "project:p") == "p")
precondition(["chat", "toggle:pinned", "view:x", "root"].allSatisfy { SessionRows.projectId(ofRow: $0) == nil })
precondition(SessionRows.projectMenu(SessionProject(id: "p", rootPath: "/x")).map(\.id) == ["newSession", "open", "copyPath"])
precondition(SessionRows.projectMenu(SessionProject(id: "w:unassigned")).map(\.id) == ["open"])

let views = catalog.viewed(["root": root.lastMessageAt!])
precondition(views.sessions[0].lastViewedMessageAt == root.lastMessageAt && views.sessions[1].lastViewedMessageAt == nil)

let day = 86_400_000.0
let midday = Calendar.current.startOfDay(for: Date(timeIntervalSince1970: now / 1000)).timeIntervalSince1970 * 1000 + 12 * hour
func item(_ id: String, _ status: String = "completed", project: String = "p", at: Double = midday, _ change: (inout SessionItem) -> Void = { _ in }) -> SessionItem {
  var session = SessionItem(id: id, title: id, status: status, projectId: project, lastMessageAt: at, lastReadAt: at)
  change(&session)
  return session
}
let inboxCatalog = SessionCatalog(projects: [SessionProject(id: "p", name: "lody-ios")], sessions: [
  item("waiting", "waiting"), item("failed", "error"), item("running", "running"),
  item("unread") { $0.lastReadAt = midday - hour }, item("pinned") { $0.pinned = true },
  item("today"), item("yesterday", at: midday - day), item("week", at: midday - 3 * day), item("month", at: midday - 20 * day),
  item("older", at: midday - 60 * day), item("archived") { $0.archived = true },
])
let inbox = InboxSections.inbox(inboxCatalog, now: midday)
precondition(inbox.map(\.id) == ["pinned", "attention", "live", "unread", "today", "yesterday", "week", "month", "older"], "\(inbox.map(\.id))")
precondition(inbox[1].rows.map(\.id) == ["waiting", "failed"] && inbox[1].header == "inbox.section.attention")
precondition(!inbox.flatMap(\.rows).contains { $0.id == "archived" }, "Archived sessions stay out until searched")
precondition(InboxSections.inbox(inboxCatalog, keyword: "archived", now: midday).flatMap(\.rows).map(\.id) == ["archived"])
precondition(inbox[2].rows[0].imageTint == "blue" && inbox[4].rows[0].imageTint.isEmpty && inbox[1].rows[1].imageTint == "danger")
precondition(inbox[1].rows[0].subtitle == "lody-ios" && inbox.flatMap(\.rows).allSatisfy { $0.diff.isEmpty })
precondition(InboxSections.inbox(inboxCatalog, chatOnly: true, now: midday).isEmpty)

let many = SessionCatalog(projects: [SessionProject(id: "p", name: "lody-ios", rootPath: "/Users/me/git/lody-ios"), SessionProject(id: "empty", name: "Empty")],
  sessions: (0..<6).map { item("s\($0)", at: midday - Double($0) * hour) } + [item("c1", project: "m:unassigned"), item("pin") { $0.pinned = true }])
let projects = InboxSections.projects(many, now: midday)
precondition(projects.map(\.id) == ["pinned", "empty", "p", "chat"], "\(projects.map(\.id))")
precondition(projects[0].rows.map(\.id) == ["toggle:pinned", "pin"] && projects[0].headerExpanded == true)
precondition(projects[1].rows[0].id == "project:empty" && projects[1].rows[0].badge == "0" && projects[1].rows[0].navigates)
let lody = projects[2]
precondition(lody.rows[0].id == "toggle:p" && lody.rows[0].subtitle == "~/git/lody-ios" && lody.rows[0].monogram == "l")
precondition(lody.rows.dropFirst().map(\.id) == ["s0", "s1", "s2", "s3", "s4", "project:p"] && lody.rows.last?.title == "inbox.project.more")
precondition(projects[3].rows.map(\.id) == ["toggle:chat", "c1"] && projects[3].rows[0].menuActions.map(\.id) == ["newChat"])
let collapsed = InboxSections.projects(many, expanded: ["p": false], now: midday)[2]
precondition(collapsed.headerExpanded == false && collapsed.rows[0].badge == "6" && collapsed.rows.count == lody.rows.count)

var urgent = many
urgent.projects.append(SessionProject(id: "z", name: "zeta"))
urgent.sessions.append(item("z1", "waiting", project: "z", at: midday - 90 * day))
precondition(InboxSections.projects(urgent, sort: .urgency, now: midday).map(\.id) == ["pinned", "z", "p", "empty", "chat"])
precondition(InboxSections.projects(urgent, sort: .activity, now: midday).map(\.id) == ["pinned", "p", "z", "empty", "chat"])
let spaced = InboxSections.projects(urgent, sort: .urgency, now: midday)
precondition(spaced.dropFirst().map(\.gap) == [.group, .section, .section, .group],
             "Pinned and Chat stand apart from the projects; projects sit a smaller step apart: \(spaced.map(\.gap))")
var unpinnedCatalog = many
unpinnedCatalog.sessions.removeAll { $0.pinned }
precondition(InboxSections.projects(unpinnedCatalog, now: midday).filter { $0.id != "chat" }.allSatisfy { $0.gap == .section },
             "Without a pinned group, projects only use the smaller step")
let zetaParent = InboxSections.projects(urgent, now: midday).first { $0.id == "z" }!.rows[0]
precondition(zetaParent.value == "inbox.project.attention" && zetaParent.imageTint == "warning")

precondition(InboxSections.reconcilePinOrder(["b", "gone", "a"], pinned: ["a", "b", "c", "d"]) { ["c": 1, "d": 2][$0] ?? 0 } == ["d", "c", "b", "a"])
precondition(InboxSections.orderPinned([item("x") { $0.pinned = true }, item("y", at: midday + 1) { $0.pinned = true }], pinOrder: ["x"]).map(\.id) == ["x", "y"])

let hits = InboxSections.match(many, keyword: "LODY")
precondition(hits.projectIds == ["p"] && hits.sessions.count == 7)
let found = InboxSections.search(many, hits: InboxSearchHits(projectIds: ["p"], sessions: [("s1", "matched line"), ("s2", nil)]), now: midday)
precondition(found.map(\.id) == ["projects", "sessions"] && found[0].rows[0].id == "project:p" && found[0].rows[0].menuActions.count == 3)
precondition(found[1].rows.map(\.id) == ["s1", "s2"] && found[1].rows[0].subtitle == "matched line" && found[1].rows[1].subtitle == "lody-ios")
let highlighted = InboxSections.search(many, hits: InboxSearchHits(projectIds: ["p"], sessions: [("s1", "matched line"), ("s2", nil)]), query: "matched", now: midday)
precondition(highlighted[1].rows.allSatisfy { $0.highlight == "matched" }, "Search rows carry the query to highlight")
precondition(highlighted[1].rows[0].wrapSubtitle && !highlighted[1].rows[1].wrapSubtitle, "Only message snippets take a second line")
precondition(highlighted[0].rows[0].highlight == "matched", "Project hits highlight too")
precondition(InboxSections.search(many, hits: InboxSearchHits()).isEmpty)
precondition(InboxSections.activityBucket(.nan, now: midday) == "today" && InboxSections.activityBucket(midday - 8 * day, now: midday) == "month")
let entry: [String: Any] = [
  "fileDiffs": [["path": "a.swift", "add": 2, "del": 1]],
  "items": [
    ["type": "tool_call", "kind": "edit", "path": "a.swift", "added": 9, "removed": 9],
    ["type": "tool_call", "kind": "read", "path": "r.swift", "added": 1],
    ["type": "tool_call", "kind": "write", "path": "n.swift", "added": 4],
    ["type": "tool_call", "kind": "edit", "path": "n.swift", "added": 1, "removed": 2],
    ["type": "tool_call", "kind": "delete", "path": "n.swift"],
    ["type": "tool_call", "kind": "edit", "path": ""],
    ["type": "text", "path": "t.swift"],
  ],
]
let files = SessionEnvelope.changedFiles(entry)
precondition(files.map { $0["path"] as? String } == ["a.swift", "n.swift"], "Recorded diffs win; reads, empty paths and non-tools are skipped")
precondition(files[0]["add"] as? Int == 2 && files[0]["status"] as? String == "M")
precondition(files[1]["add"] as? Int == 5 && files[1]["del"] as? Int == 2 && files[1]["status"] as? String == "D")
let envelope = SessionEnvelope.prepare(#"{"v":1,"status":"live","revision":4,"preview":{"label":"localhost:5173","active":true},"entries":[{"id":"e","items":[]}]}"#)!
precondition(envelope.revision == 4 && envelope.entriesJSON.contains(#""fileDiffs":[]"#))
precondition(SessionEnvelope.prepare("not json") == nil && SessionEnvelope.prepare(#"{"v":1,"overflow":true}"#)!.overflow)
precondition(envelope.accepted(generation: 0, after: (-1, -1)), "A newer runtime generation resets the cursor")
precondition(!envelope.accepted(generation: 0, after: (1, -1)), "Older generations drop")
precondition(!envelope.accepted(generation: 1, after: (1, 4)) && envelope.accepted(generation: 1, after: (1, 3)), "Same generation needs a newer revision")
precondition(!SessionEnvelope(version: 2, revision: 9).accepted(generation: 5, after: (1, 1)), "Unknown envelope versions drop")
print("PASS: session rows, inbox sections and session envelopes match the catalog projections")

let toolsCatalog = SessionCatalog.decode(saved: Data(#"{"catalog":{"projects":[],"machineIds":["mac"],"machineSimulators":{"mac":"available"},"sessions":[{"id":"with-tools","pullRequests":[{"repository":"Innei/lody-ios","number":31,"status":"open","ci":"f"}],"iosSimulatorPreviewRequestId":"preview-request"}]}}"#.utf8))!
precondition(toolsCatalog.machineSimulators["mac"] == "available")
precondition(toolsCatalog.session("with-tools")?.pullRequests.first?.number == 31)
precondition(toolsCatalog.session("with-tools")?.iosSimulatorPreviewRequestId == "preview-request")

precondition(envelope.preview == SessionBrowserPreview(label: "localhost:5173", active: true))

var tabRoot = root
tabRoot.archived = false
var directoryTab = tab
directoryTab.archived = false
var openedChat = child
openedChat.archived = false
var sidePanel = directoryTab
sidePanel.id = "side"
sidePanel.childSessionPlacement = "side-panel"
let directoryFamily = DirectoryTabs.sessions(current: directoryTab, all: [openedChat, sidePanel, directoryTab, tabRoot])
precondition(directoryFamily.map(\.id) == ["root", "tab"])
precondition(DirectoryTabs.symbol([live, chat]) == "hand.raised")
precondition(DirectoryTabs.sessions(current: tabRoot, all: [tabRoot, openedChat]).count == 1)
print("PASS: directory Tabs exclude opened chats and side panels, and waiting outranks running")

var closedRoot = tabRoot
closedRoot.isTabClosed = true
precondition(DirectoryTabs.sessions(current: directoryTab, all: [closedRoot, directoryTab]).map(\.id) == ["tab"])
precondition(DirectoryTabs.closed(current: directoryTab, all: [closedRoot, directoryTab]).map(\.id) == ["root"])
precondition(!SessionRows.isUnread(closedRoot))
let decodedClosed = try! JSONDecoder().decode(SessionItem.self, from: Data(#"{"id":"saved","isTabClosed":true}"#.utf8))
precondition(decodedClosed.isTabClosed)
print("PASS: closed Tabs remain recoverable without hiding open children")

let preferenceSuite = "tab-selection-test-" + UUID().uuidString
let preferences = UserDefaults(suiteName: preferenceSuite)!
let selection = SessionTabSelection(defaults: preferences)
selection.remember(directoryTab, all: [tabRoot, directoryTab], user: "u", workspace: "w")
let restarted = SessionTabSelection(defaults: UserDefaults(suiteName: preferenceSuite)!)
precondition(restarted.resolve(tabRoot, all: [tabRoot, directoryTab], user: "u", workspace: "w") == directoryTab.id)
precondition(restarted.resolve(tabRoot, all: [tabRoot, directoryTab], user: "other", workspace: "w") == tabRoot.id)
precondition(restarted.resolve(tabRoot, all: [tabRoot, directoryTab], user: "u", workspace: "other") == tabRoot.id)
var closedTab = directoryTab
closedTab.isTabClosed = true
precondition(restarted.resolve(tabRoot, all: [tabRoot, closedTab], user: "u", workspace: "w") == tabRoot.id)
precondition(restarted.resolve(tabRoot, all: [tabRoot], user: "u", workspace: "w") == tabRoot.id)
precondition(restarted.resolve(directoryTab, all: [tabRoot, directoryTab], user: "u", workspace: "w") == directoryTab.id)
var readTab = directoryTab
readTab.status = "idle"
readTab.lastMessageAt = 100
readTab.lastReadAt = nil
let viewedCatalog = SessionCatalog(sessions: [readTab]).viewed([readTab.id: 100])
precondition(!SessionRows.needsEmphasis(viewedCatalog.sessions[0]))
readTab.lastMessageAt = 101
precondition(SessionRows.needsEmphasis(SessionCatalog(sessions: [readTab]).viewed([readTab.id: 100]).sessions[0]))
preferences.removePersistentDomain(forName: preferenceSuite)
print("PASS: remembered Tabs survive reload, respect scope and fall back from closed/deleted Tabs; viewed watermarks preserve new unread output")

precondition(PullRequestCI("x")?.rawValue == "expected", "Expected checks must differ from running CI, as Web SessionPrIcon")

// Internal Tabs contribute attention to their listed conversation, even under My tasks.
let tabOwner = SessionItem(id: "tab-owner", userId: "me", projectId: "p", machineId: "m")
let runningTab = SessionItem(id: "running-tab", status: "running", userId: "other", projectId: "p", parentSessionId: tabOwner.id, machineId: "m")
func tabRows(_ tabs: [SessionItem], owner: String? = nil) -> [LodyListRow] {
  InboxSections.home(SessionCatalog(sessions: [tabOwner] + tabs), grouping: .status, owner: owner, now: now).flatMap(\.rows)
}
precondition(tabRows([runningTab]).map(\.id) == [tabOwner.id])
precondition(tabRows([runningTab]).first?.imageTint == "blue", "Running Tab must reach its conversation row")
precondition(tabRows([runningTab], owner: "me").first?.imageTint == "blue")
var stoppedTab = runningTab
stoppedTab.status = "idle"
precondition(tabRows([stoppedTab]).first?.imageTint == "")
stoppedTab.status = "error"
precondition(tabRows([stoppedTab]).first?.imageTint == "danger")
var waitingTab = runningTab
waitingTab.id = "nested-tab"
waitingTab.parentSessionId = runningTab.id
waitingTab.status = "requestPermission"
precondition(tabRows([runningTab, waitingTab]).first?.imageTint == "warning")
let waitingSections = InboxSections.home(SessionCatalog(sessions: [tabOwner, runningTab, waitingTab]), grouping: .status, now: now)
precondition(waitingSections.first?.id == "attention")
var closedRunning = runningTab
closedRunning.isTabClosed = true
precondition(tabRows([closedRunning]).first?.imageTint == "blue")
var excludedTab = runningTab
excludedTab.archived = true
precondition(tabRows([excludedTab]).first?.imageTint == "")
excludedTab = runningTab
excludedTab.childSessionPlacement = "side-panel"
precondition(tabRows([excludedTab]).first?.imageTint == "")
excludedTab = runningTab
excludedTab.machineId = "other-machine"
precondition(tabRows([excludedTab]).first?.imageTint == "")
var unreadTab = runningTab
unreadTab.status = "completed"
unreadTab.lastMessageAt = 20
unreadTab.lastReadAt = 10
precondition(tabRows([unreadTab]).first?.unread == true)
unreadTab.isTabClosed = true
precondition(tabRows([unreadTab]).first?.unread == false)
var separateOpenedChat = runningTab
separateOpenedChat.parentSessionId = nil
separateOpenedChat.openedBySessionId = tabOwner.id
precondition(tabRows([separateOpenedChat]).first?.imageTint == "")

// Hiding the repeated project label must not erase raw repository identity used by
// the index; an opened child from another project must not supply the root logo.
let logoCatalog = SessionCatalog(projects: [
  SessionProject(id: "logo-root", name: "Root", repoFullName: "synthetic-owner/root"),
  SessionProject(id: "logo-child", name: "Child", repoFullName: "another-owner/child"),
], sessions: [
  SessionItem(id: "logo-session", projectId: "logo-root"),
  SessionItem(id: "logo-opened", projectId: "logo-child", openedBySessionId: "logo-session"),
])
let logoGroups = InboxSections.home(logoCatalog, grouping: .project, now: now)
precondition(logoGroups.count == 1 && logoGroups[0].id == "group:logo-root")
precondition(logoGroups[0].rows[0].place.isEmpty)
precondition(logoGroups[0].rows[0].repository == "synthetic-owner/root")
precondition(logoGroups[0].rows[1].repository == "another-owner/child")
print("PASS: project grouping hides presentation while retaining root and cross-project child repository identity")


var relationRoot = SessionItem(id: "relation-root", title: "Root")
var relationTab = SessionItem(id: "relation-tab", title: "Tab", parentSessionId: relationRoot.id)
var relationChild = SessionItem(id: "relation-child", title: "Child", openedBySessionId: relationTab.id, openedByRootSessionId: relationRoot.id)
var relationSibling = SessionItem(id: "relation-sibling", openedBySessionId: relationRoot.id)
var relationGrandchild = SessionItem(id: "relation-grandchild", openedBySessionId: relationChild.id)
var relationSide = SessionItem(id: "relation-side", childSessionPlacement: "side-panel", parentSessionId: relationRoot.id)
var relationClosed = SessionItem(id: "relation-closed", isTabClosed: true, parentSessionId: relationRoot.id)
let related = [relationRoot, relationTab, relationChild, relationSibling, relationGrandchild, relationSide, relationClosed]
let relationTree = SessionRelations.tree(sessions: related, current: relationChild.id)
precondition(relationTree.hasRelations)
precondition(Set(relationTree.rows.flatMap { $0.sessions.map(\.id) }) == Set([relationRoot.id, relationTab.id, relationChild.id, relationSibling.id, relationGrandchild.id]))
precondition(relationTree.rows.first { $0.session.id == relationChild.id }?.depth == 1)
precondition(relationTree.rows.first { $0.session.id == relationGrandchild.id }?.depth == 2)
precondition(relationTree.rows.count == 4, "Contained Tabs do not add hierarchy rows")
precondition(relationTree.rows.first { $0.session.id == relationRoot.id }?.tabs.map(\.id) == [relationTab.id])
precondition(!relationTree.rows.contains { $0.session.id == relationTab.id }, "Tabs share the root row")
let branchRows = relationTree.rows
let rootBranch = SessionRelations.branch(at: 0, rows: branchRows)
let childBranch = SessionRelations.branch(at: branchRows.firstIndex { $0.session.id == relationChild.id }!, rows: branchRows)
let grandchildBranch = SessionRelations.branch(at: branchRows.firstIndex { $0.session.id == relationGrandchild.id }!, rows: branchRows)
let lastBranch = SessionRelations.branch(at: branchRows.count - 1, rows: branchRows)
precondition(rootBranch.depth == 0 && rootBranch.ancestors.isEmpty)
precondition(childBranch.depth == 1 && childBranch.continues, "Parent rail continues through its descendants to the next sibling")
precondition(grandchildBranch.depth == 2 && grandchildBranch.ancestors == [0] && !grandchildBranch.continues)
precondition(!lastBranch.continues, "Final child ends its curved branch without a dangling trunk")
precondition(SessionRelations.target(relationTab.id, sessions: related) == relationTab.id)
precondition(SessionRelations.target(relationTab.id, sessions: related.filter { $0.id != relationRoot.id }) == nil)
precondition(!SessionRelations.tree(sessions: [relationRoot, relationTab], current: relationTab.id).hasRelations)
precondition(!SessionRelations.tree(sessions: [relationRoot, relationChild], current: relationChild.id).hasRelations, "Missing precise opener must not fall back to openedByRootSessionId")
precondition(SessionRelations.tree(sessions: related, current: relationClosed.id).rows.contains { $0.tabs.contains { $0.id == relationClosed.id } })
relationRoot.archived = true
precondition(SessionRelations.target(relationTab.id, sessions: [relationRoot, relationTab]) == nil)
relationRoot.archived = false
relationRoot.openedBySessionId = relationGrandchild.id
let cycle = SessionRelations.tree(sessions: [relationRoot, relationTab, relationChild, relationGrandchild], current: relationChild.id)
precondition(cycle.rows.count == 3 && Set(cycle.rows.flatMap { $0.sessions.map(\.id) }).count == 4)
print("Related conversations: precise opener, containment, exact Tab targets, missing/archived roots and cycles passed")
