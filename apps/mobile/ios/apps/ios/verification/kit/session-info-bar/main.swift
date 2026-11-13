import Foundation

func check(_ value: Bool, _ message: String) { if !value { fatalError(message) } }
let draft = SessionPullRequest(repository: "owner/repo", number: 7, status: "draft", merge: "c")
var session = SessionItem(id: "session")
session.pullRequests = [draft]
var updates = SessionPullRequestUpdates()
func bar(_ value: SessionItem) -> SessionInfoBar { SessionInfoBar(session: value, repository: "owner/repo", busy: false) }
check(bar(updates.apply(session)).actions == [.readyForReview], "unconfirmed writes leave the action intact")
updates.confirm(draft, merged: false)
check(bar(updates.apply(session)).pullRequest?.status == "open", "ready success immediately opens the PR")
check(!bar(updates.apply(session)).actions.contains(.readyForReview), "stale catalog cannot restore Ready")
updates.confirm(draft, merged: true)
check(bar(updates.apply(session)).pullRequest?.status == "merged", "merge succeeds even before ready sync arrives")
check(bar(updates.apply(session)).actions.isEmpty, "merged PR cannot offer more writes")
session.pullRequests = [SessionPullRequest(repository: "another/repo", number: 7, status: "draft")]
check(updates.apply(session).pullRequests.first?.status == "draft", "same PR number in another repository is untouched")

updates = SessionPullRequestUpdates()
updates.confirm(draft, merged: false)
session.pullRequests = [draft]
session.pullRequests[0].status = "open"
session.pullRequests[0].ci = "f"
check(bar(updates.apply(session)).actions == [.fixCi, .merge], "fresh CI survives reconciliation")
session.pullRequests[0].status = "draft"
check(bar(updates.apply(session)).actions == [.readyForReview], "after convergence, a later re-draft is authoritative")
print("PASS: confirmed PR transitions and catalog convergence")

// Merge is offered whenever GitHub would accept it, including while CI runs.
var open = SessionPullRequest(repository: "owner/repo", number: 8, status: "open", ci: "p", merge: "u")
session.pullRequests = [open]
check(bar(session).actions == [.merge], "unstable while CI runs offers Merge")
open.ci = "f"; session.pullRequests = [open]
check(bar(session).actions == [.fixCi, .merge], "failing optional checks keep Merge behind Fix CI")
for blocked in ["b", "h", "d"] {
  open.ci = "p"; open.merge = blocked; session.pullRequests = [open]
  check(!bar(session).actions.contains(.merge), "\(blocked) cannot be merged")
}
open.merge = nil; session.pullRequests = [open]
check(bar(session).actions.isEmpty, "an unknown merge state offers no Merge")
print("PASS: Merge follows GitHub's merge state, not CI completion")

updates = SessionPullRequestUpdates()
session.pullRequests = [draft]
updates.begin(draft, merged: false)
check(bar(updates.apply(session)).pullRequest?.status == "draft", "ready in flight keeps the catalog status")
updates.finish(success: false)
check(bar(updates.apply(session)).pullRequest?.status == "draft", "failed ready restores the catalog")
updates.begin(draft, merged: true)
check(bar(updates.apply(session)).pullRequest?.status == "draft", "merge in flight is not shown as merged")
updates.finish(success: true)
check(bar(updates.apply(session)).pullRequest?.status == "merged", "success survives old catalog frames")
print("PASS: PR status changes only after GitHub acknowledges the write")

// Ready for review on a draft (no catalog merge state): Merge appears from GitHub's own read.
updates = SessionPullRequestUpdates()
let pendingDraft = SessionPullRequest(repository: "owner/repo", number: 7, status: "draft")
session.pullRequests = [pendingDraft]
updates.confirm(pendingDraft, merged: false)
check(bar(updates.apply(session)).actions.isEmpty, "a ready PR without a merge state offers no Merge yet")
updates.observeMerge(pendingDraft, merge: "c")
check(bar(updates.apply(session)).actions == [.merge], "GitHub's clean state offers Merge before the catalog catches up")
session.pullRequests[0].status = "open"
check(bar(updates.apply(session)).actions == [.merge], "an open catalog frame still lacking merge keeps the read state")
session.pullRequests[0].merge = "b"
check(bar(updates.apply(session)).actions.isEmpty, "the catalog's own merge state wins")
session.pullRequests[0].merge = nil
check(bar(updates.apply(session)).actions.isEmpty, "a read state is dropped once the catalog reported one")
updates.observeMerge(pendingDraft, merge: "c")
session.pullRequests[0].status = "draft"
check(bar(updates.apply(session)).actions == [.readyForReview], "a re-drafted PR drops the read state")
session.pullRequests[0].status = "open"
check(bar(updates.apply(session)).actions.isEmpty, "the dropped read state does not return")

check(PullRequestMergeSettle.code(state: "clean", mergeable: true, draft: false) == "c", "clean maps to c")
check(PullRequestMergeSettle.code(state: "has_hooks", mergeable: true, draft: false) == "u", "has_hooks maps to u")
check(PullRequestMergeSettle.code(state: "unknown", mergeable: nil, draft: false) == nil, "unknown is still pending")
check(PullRequestMergeSettle.code(state: "unknown", mergeable: false, draft: false) == "d", "unknown + not mergeable is a conflict")
check(PullRequestMergeSettle.code(state: "clean", mergeable: true, draft: true) == nil, "a draft has no merge state")

var reads: [String?] = [nil, nil, "c"]
var sleeps = 0
var settled = await PullRequestMergeSettle.run(read: { reads.removeFirst() }, sleep: { sleeps += 1 })
check(settled == "c" && sleeps == 2, "settling stops at the first computed state")
sleeps = 0
settled = await PullRequestMergeSettle.run(attempts: 3, read: { nil }, sleep: { sleeps += 1 })
check(settled == nil && sleeps == 2, "settling is bounded")
settled = await PullRequestMergeSettle.run(read: { throw NSError(domain: "synthetic-read", code: 1) }, sleep: { sleeps += 1 })
check(settled == nil, "a failed read ends settling")
print("PASS: merge state read after Ready for review until the catalog converges")

// Release the pending write explicitly after navigation, without clocks or network.
@MainActor final class ArchiveGate {
  var continuation: CheckedContinuation<Void, Error>?
  var current = true
  func write() async throws {
    try await withCheckedThrowingContinuation { continuation = $0 }
  }
}
for outcome in ["success", "failure", "retired-scope"] {
  let gate = ArchiveGate()
  var atHome = false
  var warning = false
  var completed = false
  let operation = SessionArchive.start(isCurrent: { gate.current }, write: {
    try await gate.write()
    completed = true
  }, returnToList: { atHome = true }, failed: { warning = true })
  check(atHome && !completed && !warning, "Archive must navigate synchronously before completion")
  while gate.continuation == nil { await Task.yield() }
  if outcome == "retired-scope" { gate.current = false }
  if outcome == "success" { gate.continuation!.resume() }
  else { gate.continuation!.resume(throwing: NSError(domain: "synthetic-archive", code: 1)) }
  await operation.value
  check(atHome, "A delayed result must not reopen the page")
  check(completed == (outcome == "success"), "Archive write must survive navigation")
  check(warning == (outcome == "failure"), "Only failure in the original active scope warns")
}
print("PASS: immediate archive navigation, delayed completion and scoped failure feedback")


var zeroLineSession = SessionItem(id: "zero-line")
zeroLineSession.diff = ["add": 0, "del": 0, "files": 2]
let zeroLineBar = SessionInfoBar(session: zeroLineSession, repository: "", busy: false)
check(zeroLineBar.hasDiff && zeroLineBar.hasContext && zeroLineBar.files == 2, "Zero-line changes keep the context and complete file count")
zeroLineSession.diff = ["add": 3, "del": 1, "files": 2]
check(bar(zeroLineSession).added == 3 && bar(zeroLineSession).removed == 1, "Mixed text and binary changes retain the text totals")
zeroLineSession.diff = ["add": 3, "del": 1, "files": 0]
check(!bar(zeroLineSession).hasDiff, "An explicit empty comparison removes the diff entry")
zeroLineSession.diff = ["add": 3, "del": 1]
check(bar(zeroLineSession).hasDiff, "Older daemons keep text-only entries")
let zeroLineData = Data(#"{"id":"files","diff":{"add":0,"del":0,"files":2}}"#.utf8)
let decodedZeroLine = try JSONDecoder().decode(SessionItem.self, from: zeroLineData)
check(decodedZeroLine.diff["files"] == 2 && bar(decodedZeroLine).hasDiff, "Catalog decoding preserves file counts independently of text lines")
print("PASS: zero-line and mixed workspace summaries retain the review entry")
