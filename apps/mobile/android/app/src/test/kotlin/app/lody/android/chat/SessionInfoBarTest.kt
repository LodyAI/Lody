package app.lody.android.chat

import app.lody.android.chat.SessionInfoBar.Action
import app.lody.android.runtime.CatalogPullRequest
import app.lody.android.runtime.CatalogSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionInfoBarTest {
    @Test fun pendingWritesProjectImmediatelyAndRollBackOnFailure() {
        val updates = SessionPullRequestUpdates()
        val draft = pr("draft")
        val stale = session(pr = draft)
        updates.begin(draft, merged = false)
        assertEquals("open", updates.apply(stale).pullRequests.last().status)
        updates.finish(success = false)
        assertEquals("draft", updates.apply(stale).pullRequests.last().status)
        updates.begin(draft, merged = true)
        assertEquals("merged", updates.apply(stale).pullRequests.last().status)
        updates.finish(success = true)
        assertEquals("merged", updates.apply(stale).pullRequests.last().status)
    }

    @Test fun confirmedWritesUpdateImmediatelyAndYieldToTheCatalogAfterConvergence() {
        val updates = SessionPullRequestUpdates()
        val draft = pr("draft", merge = "c")
        val stale = session(pr = draft)
        assertEquals(listOf(Action.ReadyForReview), actions(updates.apply(stale)))
        updates.confirm(draft, merged = false)
        assertEquals("open", updates.apply(stale).pullRequests.last().status)
        assertEquals(listOf(Action.Merge), actions(updates.apply(stale)))
        updates.confirm(draft, merged = true)
        assertEquals("merged", updates.apply(stale).pullRequests.last().status)
        assertTrue(actions(updates.apply(stale)).isEmpty())
        val other = session(pr = draft.copy(repository = "another/repo"))
        assertEquals("draft", updates.apply(other).pullRequests.last().status)

        val ready = SessionPullRequestUpdates()
        ready.confirm(draft, merged = false)
        assertEquals(listOf(Action.FixCi), actions(ready.apply(session(pr = pr(ci = "f")))))
        assertEquals(listOf(Action.ReadyForReview), actions(ready.apply(stale)))
    }

    private fun session(
        dirty: Boolean = false, unpushed: Boolean = false, added: Int = 0, pr: CatalogPullRequest? = null,
    ) = CatalogSession(
        "s", "m", "github:lody/zed", "Chat", "idle", false, false, "2026-11-01T00:00:00Z",
        branchName = "feat/bar", pullRequests = listOfNotNull(pr),
        diffAdded = added, workspaceDirty = dirty, workspaceUnpushed = unpushed,
    )

    private fun pr(status: String = "open", ci: String? = null, merge: String? = null) =
        CatalogPullRequest("lody/zed", 7, status, ci, "https://github.com/lody/zed/pull/7", merge)

    private fun actions(session: CatalogSession, busy: Boolean = false, repository: String = "lody/zed") =
        SessionInfoBar.of(session, repository, busy).actions

    @Test fun withoutPrCreatePrNeedsAnyChangeAndCommitNeedsUncommittedWork() {
        assertEquals(emptyList<Action>(), actions(session()))
        assertEquals(listOf(Action.CreatePr, Action.CreateDraftPr), actions(session(added = 3)))
        assertEquals(listOf(Action.CreatePr, Action.CreateDraftPr, Action.CommitAndPush), actions(session(dirty = true)))
    }

    @Test fun unpublishedWorkOutranksRepairOnAnOpenPr() {
        val session = session(unpushed = true, pr = pr(ci = "f", merge = "d"))
        assertEquals(listOf(Action.CommitAndPush, Action.ResolveConflicts, Action.FixCi), actions(session))
        assertEquals(listOf(Action.FixCi), actions(session(pr = pr(ci = "e"))))
    }

    @Test fun aCleanPassingPrOffersMergeEvenBehindPublishing() {
        assertEquals(listOf(Action.Merge), actions(session(pr = pr(merge = "c"))))
        assertEquals(listOf(Action.CommitAndPush, Action.Merge), actions(session(unpushed = true, pr = pr(ci = "s", merge = "c"))))
        assertEquals(emptyList<Action>(), actions(session(pr = pr(ci = "p", merge = "c"))))
        assertEquals(emptyList<Action>(), actions(session(pr = pr(merge = "b"))))
    }

    @Test fun draftAndFinishedPrsOfferPublishingAndReadiness() {
        assertEquals(listOf(Action.CommitAndPush, Action.ReadyForReview), actions(session(dirty = true, pr = pr("draft", ci = "f"))))
        assertEquals(emptyList<Action>(), actions(session(dirty = true, pr = pr("merged"))))
    }

    @Test fun busyOrRepositoryLessSessionsOfferNothing() {
        assertEquals(emptyList<Action>(), actions(session(dirty = true), busy = true))
        assertEquals(emptyList<Action>(), actions(session(dirty = true), repository = ""))
    }

    @Test fun promptsCarryThePullRequest() {
        val bar = SessionInfoBar.of(session(pr = pr(ci = "f", merge = "d")), "lody/zed", busy = false)
        val prompts = SessionInfoBar.Prompts("o", "do", "c", "dc", "u", "cp", "%1\$s %2\$s %3\$s", "%1\$s #%2\$d %3\$s %4\$s")
        assertEquals("lody/zed #7 https://github.com/lody/zed/pull/7", bar.prompt(Action.ResolveConflicts, prompts))
        assertEquals("lody/zed #7 https://github.com/lody/zed/pull/7 feat/bar", bar.prompt(Action.FixCi, prompts))
        assertEquals("o\n\nc\n\nu", bar.prompt(Action.CreatePr, prompts))
        assertTrue(bar.hasContext)
    }
}
