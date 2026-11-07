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
check(bar(updates.apply(session)).pullRequest?.status == "draft", "same PR number in another repository is untouched")

updates = SessionPullRequestUpdates()
updates.confirm(draft, merged: false)
session.pullRequests = [draft]
session.pullRequests[0].status = "open"
session.pullRequests[0].ci = "f"
check(bar(updates.apply(session)).actions == [.fixCi], "fresh CI survives reconciliation")
session.pullRequests[0].status = "draft"
check(bar(updates.apply(session)).actions == [.readyForReview], "after convergence, a later re-draft is authoritative")
print("PASS: confirmed PR transitions and catalog convergence")

updates = SessionPullRequestUpdates()
session.pullRequests = [draft]
updates.begin(draft, merged: false)
check(bar(updates.apply(session)).pullRequest?.status == "open", "ready changes immediately before response")
updates.finish(success: false)
check(bar(updates.apply(session)).pullRequest?.status == "draft", "failed ready restores the catalog")
updates.begin(draft, merged: true)
check(bar(updates.apply(session)).pullRequest?.status == "merged", "merge changes immediately before response")
updates.finish(success: true)
check(bar(updates.apply(session)).pullRequest?.status == "merged", "success survives old catalog frames")
print("PASS: optimistic PR transitions roll back on failure")
