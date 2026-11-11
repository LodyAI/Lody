package app.lody.android.chat

import app.lody.android.chat.SessionInfoBar.Action
import app.lody.android.runtime.CatalogJson
import app.lody.android.runtime.CatalogProjectMember
import app.lody.android.runtime.CatalogProjectRun
import app.lody.android.runtime.CatalogPullRequest
import app.lody.android.runtime.CatalogSession
import app.lody.android.auth.Credential
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionInfoBarTest {
    @Test fun pendingWritesKeepTheCatalogStatusUntilGitHubAcknowledges() {
        val updates = SessionPullRequestUpdates()
        val draft = pr("draft")
        val stale = session(pr = draft)
        updates.begin(draft, merged = false)
        assertTrue(updates.writes(draft))
        assertEquals("draft", updates.apply(stale).pullRequests.last().status)
        updates.finish(success = false)
        assertEquals("draft", updates.apply(stale).pullRequests.last().status)
        updates.begin(draft, merged = true)
        assertEquals("draft", updates.apply(stale).pullRequests.last().status)
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

    @Test fun mergeAppearsFromGitHubsReadStateUntilTheCatalogHasItsOwn() {
        val updates = SessionPullRequestUpdates()
        val draft = pr("draft")
        updates.confirm(draft, merged = false)
        assertTrue(actions(updates.apply(session(pr = draft))).isEmpty())
        updates.observeMerge(draft, "c")
        assertEquals(listOf(Action.Merge), actions(updates.apply(session(pr = draft))))
        assertEquals(listOf(Action.Merge), actions(updates.apply(session(pr = pr("open")))))
        assertTrue(actions(updates.apply(session(pr = pr("open", merge = "b")))).isEmpty())
        assertTrue(actions(updates.apply(session(pr = pr("open")))).isEmpty())

        val redrafted = SessionPullRequestUpdates()
        redrafted.observeMerge(draft, "c")
        assertEquals(listOf(Action.ReadyForReview), actions(redrafted.apply(session(pr = draft))))
        assertTrue(actions(redrafted.apply(session(pr = pr("open")))).isEmpty())
    }

    @Test fun mergeStateSettlesOnTheFirstComputedReadAndIsBounded() = runTest {
        val reads = ArrayDeque(listOf(null, null, "c"))
        var sleeps = 0
        assertEquals("c", PullRequestMergeSettle.run(read = { reads.removeFirst() }, sleep = { sleeps++ }))
        assertEquals(2, sleeps)
        sleeps = 0
        assertNull(PullRequestMergeSettle.run(attempts = 3, read = { null }, sleep = { sleeps++ }))
        assertEquals(2, sleeps)
        assertNull(PullRequestMergeSettle.run(read = { throw GitHubWriteFailure("rate_limited") }, sleep = {}))
    }

    @Test fun mergeStateReadsThePullRequestWithAReadGrant() = runTest {
        var grantOperation: String? = null
        var pull = JSONObject().put("state", "open").put("draft", false).put("mergeable", JSONObject.NULL).put("mergeable_state", "unknown")
        val writes = GitHubPullRequestWrites { method, url, _, body ->
            when {
                url.endsWith("/api/auth/convex/token") -> 200 to JSONObject().put("token", "jwt").toString()
                url.endsWith("/api/action") -> {
                    grantOperation = body!!.getJSONArray("args").getJSONObject(0).getString("operation")
                    200 to JSONObject().put("status", "success").put("value", JSONObject().put("success", true).put("token", "grant")).toString()
                }
                method == "GET" && url == "https://api.github.com/repos/lody/zed/pulls/7" -> 200 to pull.toString()
                else -> error("unexpected $method $url")
            }
        }
        val credential = Credential("synthetic-session")
        assertNull(writes.mergeState(credential, "w", "lody/zed", 7))
        assertEquals("read", grantOperation)
        pull = pull.put("mergeable", true).put("mergeable_state", "clean")
        assertEquals("c", writes.mergeState(credential, "w", "lody/zed", 7))
        pull = pull.put("mergeable", false).put("mergeable_state", "unknown")
        assertEquals("d", writes.mergeState(credential, "w", "lody/zed", 7))
        pull = pull.put("draft", true).put("mergeable_state", "draft")
        assertNull(writes.mergeState(credential, "w", "lody/zed", 7))
        pull = pull.put("draft", false).put("state", "closed").put("mergeable_state", "clean")
        assertNull(writes.mergeState(credential, "w", "lody/zed", 7))
    }

    @Test fun projectPullRequestLinksOpenThePanelAndOthersStayInTheBrowser() {
        val members = listOf("Lody/Zed", "lody/docs")
        // Case-insensitive, named with the project's spelling; tabs, queries and fragments allowed.
        assertEquals(PullRequestLink("Lody/Zed", 7), PullRequestLink.inProject("https://github.com/lody/zed/pull/7/files?w=1#diff", members))
        assertEquals(PullRequestLink("lody/docs", 12), PullRequestLink.inProject("http://www.github.com/lody/docs/pull/12", members))
        // Another repository, a non-PR page, a malformed number or another host stays in the browser.
        assertNull(PullRequestLink.inProject("https://github.com/other/zed/pull/7", members))
        assertNull(PullRequestLink.inProject("https://github.com/lody/zed/issues/7", members))
        assertNull(PullRequestLink.inProject("https://github.com/lody/zed/pull/+7", members))
        assertNull(PullRequestLink.inProject("https://github.com/lody/zed/pull/0", members))
        assertNull(PullRequestLink.inProject("https://gist.github.com/lody/zed/pull/7", members))
        assertNull(PullRequestLink.inProject("https://github.com/lody/zed/pull/7", emptyList()))
        // The session's reported PR keeps its catalog state; an unknown one starts without a status.
        val link = PullRequestLink("lody/zed", 7)
        assertEquals(pr("draft", ci = "p"), link.reference(listOf(pr("draft", ci = "p"))))
        assertEquals(CatalogPullRequest("lody/zed", 8, "", url = "https://github.com/lody/zed/pull/8"), PullRequestLink("lody/zed", 8).reference(listOf(pr())))
    }

    @Test fun linkedPullRequestDetailsUseCatalogStatesFromGitHub() {
        val open = JSONObject().put("state", "open").put("merged", false).put("draft", false).put("mergeable", true)
            .put("mergeable_state", "clean").put("head", JSONObject().put("ref", "feat/x")).put("additions", 12).put("deletions", 3)
        assertEquals(PullRequestDetails("open", "c", "feat/x", 12, 3), PullRequestDetails.of(open))
        assertEquals("draft", PullRequestDetails.of(JSONObject(open.toString()).put("draft", true)).status)
        assertNull(PullRequestDetails.of(JSONObject(open.toString()).put("draft", true)).merge)
        assertEquals(PullRequestDetails("merged", null, "feat/x", 12, 3), PullRequestDetails.of(JSONObject(open.toString()).put("state", "closed").put("merged", true)))
        assertEquals("closed", PullRequestDetails.of(JSONObject(open.toString()).put("state", "closed")).status)
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

    @Test fun mergeIsOfferedWheneverGitHubWouldAcceptItEvenBehindPublishing() {
        assertEquals(listOf(Action.Merge), actions(session(pr = pr(merge = "c"))))
        assertEquals(listOf(Action.CommitAndPush, Action.Merge), actions(session(unpushed = true, pr = pr(ci = "s", merge = "c"))))
        // Checks still running or failing but not required: GitHub reports unstable and merges.
        assertEquals(listOf(Action.Merge), actions(session(pr = pr(ci = "p", merge = "u"))))
        assertEquals(listOf(Action.FixCi, Action.Merge), actions(session(pr = pr(ci = "f", merge = "u"))))
        for (blocked in listOf("b", "h")) assertEquals(emptyList<Action>(), actions(session(pr = pr(ci = "p", merge = blocked))))
        assertEquals(emptyList<Action>(), actions(session(pr = pr(ci = "p"))))
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

    @Test fun aSingleRepositoryShowsOnlyItsOwnLatestPr() {
        val other = pr().copy(repository = "lody/other", number = 9)
        val bar = SessionInfoBar.of(session(pr = pr()).let { it.copy(pullRequests = it.pullRequests + other) }, "lody/zed", busy = false)
        assertEquals(7, bar.pullRequest?.number)
    }

    private fun member(
        id: String, repo: String?, diff: Int? = null, dirty: Boolean = false, pr: CatalogPullRequest? = null, access: String? = null,
    ) = CatalogProjectMember(
        id, id, if (repo == null) "local" else "github", repoFullName = repo, branch = "lody/$id", access = access,
        diffAdded = diff, diffRemoved = diff?.let { 0 }, dirty = dirty, pullRequest = pr,
    )

    private fun group(vararg members: CatalogProjectMember, dirty: Boolean = false, added: Int = 0) =
        session(dirty = dirty, added = added).copy(projectId = "group:g", projectRun = CatalogProjectRun("g", "Platform", members.toList()))

    @Test fun aProjectGroupListsMembersAndKeepsOnlyConversationWideActions() {
        val apiPr = pr(ci = "f", merge = "c").copy(repository = "acme/api")
        // Every changed member has an open PR: no Create PR, and PR-bound repairs stay on the member's panel.
        val covered = group(member("api", "acme/api", diff = 3, pr = apiPr), member("docs", null, access = "additional"))
        val bar = SessionInfoBar.of(covered, "", busy = false)
        assertEquals("Platform", bar.group?.name)
        assertNull(bar.pullRequest)
        assertTrue(bar.hasContext)
        assertEquals(emptyList<Action>(), bar.actions)
        // Another changed repository without a PR still needs one; unpublished work leads once PRs exist.
        val uncovered = group(member("api", "acme/api", dirty = true, pr = apiPr), member("web", "acme/web", diff = 2))
        assertEquals(listOf(Action.CommitAndPush, Action.CreatePr, Action.CreateDraftPr), actions(uncovered, repository = ""))
        // Without per-member reports, the conversation totals decide, as for one repository.
        assertEquals(listOf(Action.CreatePr, Action.CreateDraftPr, Action.CommitAndPush),
            actions(group(member("api", "acme/api"), dirty = true), repository = ""))
        assertEquals(emptyList<Action>(), actions(uncovered, busy = true, repository = ""))
    }

    @Test fun projectGroupPromptsPublishEveryChangedMember() {
        val bar = SessionInfoBar.of(group(member("api", "acme/api", diff = 1)), "", busy = false)
        val prompts = SessionInfoBar.Prompts("o", "do", "c", "dc", "u", "cp", "", "")
        assertEquals("o\n\nc\n\nu\n\n${SessionInfoBar.PROJECT_GROUP_SCOPE}", bar.prompt(Action.CreatePr, prompts))
        assertEquals("cp\n\n${SessionInfoBar.PROJECT_GROUP_SCOPE}", bar.prompt(Action.CommitAndPush, prompts))
    }

    @Test fun projectGroupSnapshotsSurviveTheCatalogCache() {
        val run = CatalogProjectRun("g", "Platform", listOf(
            member("api", "acme/api", diff = 2, dirty = true, pr = pr().copy(repository = "acme/api")),
            member("proto", "acme/proto").copy(depth = 1, submodule = true),
            member("docs", null, access = "link"),
        ))
        val saved = CatalogJson.putSession(JSONObject(), group().copy(projectRun = run))
        val restored = CatalogJson.session(session(), JSONObject(saved.toString()))
        assertEquals(run, restored.projectRun)
        // A malformed member is skipped, never the session.
        saved.getJSONObject("projectRun").getJSONArray("members").put(JSONObject().put("id", "broken"))
        assertEquals(3, CatalogJson.session(session(), saved).projectRun?.members?.size)
    }
}
