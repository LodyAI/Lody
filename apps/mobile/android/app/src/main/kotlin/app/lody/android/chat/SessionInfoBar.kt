package app.lody.android.chat

import app.lody.android.runtime.CatalogProjectRun
import app.lody.android.runtime.CatalogPullRequest
import app.lody.android.runtime.CatalogSession

class SessionPullRequestUpdates {
    private val confirmed = mutableMapOf<Pair<String, Int>, String>()
    /** Merge states read straight from GitHub after Ready for review, until the catalog has one. */
    private val merges = mutableMapOf<Pair<String, Int>, String>()
    private var pending: Pair<CatalogPullRequest, Boolean>? = null
    fun begin(pr: CatalogPullRequest, merged: Boolean) { pending = pr to merged }
    fun finish(success: Boolean) {
        if (success) pending?.let { (pr, merged) -> confirm(pr, merged) }
        pending = null
    }
    private fun key(pr: CatalogPullRequest) = pr.repository.lowercase() to pr.number
    /** Only acknowledged writes override stale catalog frames, until the catalog catches up. */
    fun confirm(pr: CatalogPullRequest, merged: Boolean) {
        confirmed[key(pr)] = if (merged) "merged" else "open"
    }
    /**
     * A draft has no merge state, and the computer's poller may not refresh the PR for minutes,
     * so the merge state GitHub computes after Ready for review is read directly (web
     * `useGitHubPrDetails` does the same) and held until the catalog reports one of its own.
     */
    fun observeMerge(pr: CatalogPullRequest, merge: String) {
        if (merge in setOf("c", "b", "d", "h", "u")) merges[key(pr)] = merge
    }
    fun apply(session: CatalogSession): CatalogSession = session.copy(pullRequests = session.pullRequests.map { pr ->
        val id = key(pr)
        val status = confirmed[id] ?: return@map pr
        if (pr.status == status || (status == "open" && pr.status != "draft")) {
            confirmed.remove(id)
            pr
        } else pr.copy(status = status)
    }.map { pr ->
        val id = key(pr)
        val merge = merges[id] ?: return@map pr
        // The catalog's own state wins once it has one; a closed, merged or re-drafted PR drops it.
        if (pr.merge != null || pr.status != "open") {
            merges.remove(id)
            pr
        } else pr.copy(merge = merge)
    }.map { pr ->
        val (target, merged) = pending ?: return@map pr
        if (key(pr) == key(target) && (merged || pr.status == "draft")) pr.copy(status = if (merged) "merged" else "open")
        else pr
    })
}

/**
 * Reads GitHub's merge state after Ready for review. GitHub computes it in the background
 * (`unknown` meanwhile), so a few spaced reads replace waiting on the computer's PR poller.
 * Bounded; a failed read ends it quietly, since the catalog still converges on its own. iOS:
 * `PullRequestMergeSettle`.
 */
object PullRequestMergeSettle {
    const val ATTEMPTS = 15
    const val INTERVAL_MS = 2_000L
    private val Known = mapOf("clean" to "c", "blocked" to "b", "dirty" to "d", "behind" to "h", "unstable" to "u", "has_hooks" to "u")

    /** GitHub REST `mergeable_state` mapped like the CLI poller's `mapMergeState`; null while pending. */
    fun code(state: String?, mergeable: Boolean?, draft: Boolean): String? = when {
        draft -> null
        state != null && state in Known -> Known.getValue(state)
        mergeable == false -> "d"
        else -> null
    }

    suspend fun run(attempts: Int = ATTEMPTS, read: suspend () -> String?, sleep: suspend () -> Unit): String? {
        repeat(attempts) { attempt ->
            try {
                if (attempt > 0) sleep()
                read()?.let { return it }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { return null }
        }
        return null
    }
}

/**
 * Web `SessionInfoBar` (the action bar above the composer), reduced to what the catalog carries:
 * the repository context (PR, CI, branch, ±diff) and the repository actions, ranked like
 * `resolveSessionInfoBarGitHubActionIds`. Merge and Ready for review write to GitHub directly
 * with the workspace's brokered grant ([GitHubPullRequestWrites]); the rest send an agent prompt.
 * Goal and schedule stay on web: the catalog carries neither. iOS: `SessionInfoBar`.
 */
data class SessionInfoBar(
    val repository: String,
    val branch: String,
    val pullRequest: CatalogPullRequest?,
    val added: Int,
    val removed: Int,
    /** Priority order: the first is the bar's one text button, the rest hang off its menu. */
    val actions: List<Action>,
    /**
     * A Project group conversation: the context lists every member with its own PR instead of one
     * repository, and the actions apply to the whole group (iOS `SessionInfoBar.group`).
     */
    val group: CatalogProjectRun? = null,
) {
    enum class Action {
        CreatePr, CreateDraftPr, CommitAndPush, ResolveConflicts, FixCi, ReadyForReview, Merge;

        /** Direct GitHub writes rather than agent prompts. */
        val direct: Boolean get() = this == Merge || this == ReadyForReview
    }

    val hasContext: Boolean get() = group != null || repository.isNotEmpty() || branch.isNotEmpty() || added + removed > 0 || pullRequest != null

    val pullRequestUrl: String
        get() = pullRequest?.let { it.url ?: "https://github.com/${it.repository}/pull/${it.number}" }.orEmpty()

    /** Localized templates, resolved by the screen (web's quick-action prompts). */
    data class Prompts(
        val createPrOrigin: String,
        val createDraftPrOrigin: String,
        val createPr: String,
        val createDraftPr: String,
        val upkeep: String,
        val commitAndPush: String,
        /** `%1$s` repository, `%2$s` PR label, `%3$s` URL. */
        val resolveConflicts: String,
        /** `%1$s` repository, `%2$d` number, `%3$s` URL, `%4$s` head branch. */
        val fixCi: String,
    )

    /** The turn an action sends; empty when the action needs a PR that is gone. */
    fun prompt(action: Action, prompts: Prompts): String = when (action) {
        Action.CreatePr -> "${prompts.createPrOrigin}\n\n${scoped("${prompts.createPr}\n\n${prompts.upkeep}")}"
        Action.CreateDraftPr -> "${prompts.createDraftPrOrigin}\n\n${scoped("${prompts.createDraftPr}\n\n${prompts.upkeep}")}"
        Action.CommitAndPush -> scoped(prompts.commitAndPush)
        Action.ResolveConflicts -> pullRequest?.let { prompts.resolveConflicts.format(repository, "#${it.number}", pullRequestUrl) }.orEmpty()
        Action.FixCi -> pullRequest?.let { prompts.fixCi.format(repository, it.number, pullRequestUrl, branch.ifEmpty { "-" }) }.orEmpty()
        Action.ReadyForReview, Action.Merge -> ""
    }

    /** Web `withProjectGroupPrScope`: a group conversation publishes every changed member. */
    private fun scoped(prompt: String): String = if (group == null) prompt else "$prompt\n\n$PROJECT_GROUP_SCOPE"

    companion object {
        /**
         * Web `withProjectGroupPrScope` (`packages/shared/src/pr-prompts.ts`), sent untranslated as web
         * does: it instructs the agent rather than reading back to the user.
         */
        val PROJECT_GROUP_SCOPE = listOf(
            "Project group scope:",
            "- Apply the requested action to each member repository with changes or unpublished commits. Use the member inventory in this conversation and run Git in each member directory; the Project group directory itself is not a Git repository.",
            "- Process submodules before their parents, recursively: commit and push each changed submodule first, then update and commit its gitlink in the parent repository and push the parent branch.",
            "- If this action requests PRs, create or update one PR per changed repository. Open submodule PRs before parent PRs, preserve the requested draft or regular status, and link all related PRs in each PR body once their URLs are available.",
            "- If this action only requests Commit & Push, do not open PRs. If PR upkeep was requested, apply it to each repository with a PR.",
            "- If publishing a child fails, report the failure and do not publish a parent gitlink pointing to that unpublished commit. Report results and any PR URLs per repository.",
        ).joinToString("\n")

        fun of(session: CatalogSession, repository: String, busy: Boolean): SessionInfoBar {
            session.projectRun?.takeIf { it.members.isNotEmpty() }?.let { run ->
                return SessionInfoBar(
                    "", "", null, session.diffAdded, session.diffRemoved,
                    if (busy) emptyList() else groupActions(session, run), run,
                )
            }
            // The machine appends associations; the last one for this repository is the current PR
            // (web `selectPrimarySessionPullRequest`).
            val pr = session.pullRequests.lastOrNull { it.repository.equals(repository, ignoreCase = true) }
                .takeIf { repository.isNotEmpty() }
            return SessionInfoBar(
                repository, session.branchName.orEmpty(), pr, session.diffAdded, session.diffRemoved,
                actions(session, pr, repository, busy),
            )
        }

        /**
         * Web keeps Create PR and Commit & Push conversation-wide for a group; PR-bound actions
         * (merge, ready, CI, conflicts) belong to one member's PR and live on that PR's panel.
         */
        fun groupActions(session: CatalogSession, run: CatalogProjectRun): List<Action> {
            val unpublished = session.workspaceDirty || session.workspaceUnpushed || run.members.any { it.dirty || it.unpushed }
            val reported = run.members.any { it.diffAdded != null || it.dirty || it.unpushed }
            // A changed repository without an open PR still needs one. Members used in place have no PR.
            val needsPullRequest = if (reported) {
                run.members.any { member ->
                    val open = member.pullRequest?.status.let { it == "open" || it == "draft" }
                    val changed = (member.diffAdded ?: 0) + (member.diffRemoved ?: 0) > 0 || member.dirty || member.unpushed
                    !member.inPlace && member.repoFullName != null && changed && !open
                }
            } else {
                run.pullRequests.isEmpty() && (unpublished || session.diffAdded + session.diffRemoved > 0)
            }
            val create = if (needsPullRequest) listOf(Action.CreatePr, Action.CreateDraftPr) else emptyList()
            val commit = if (unpublished) listOf(Action.CommitAndPush) else emptyList()
            // Without any PR, creating one leads; once PRs exist, unpublished work outranks the rest.
            return if (run.pullRequests.isEmpty()) create + commit else commit + create
        }

        fun actions(session: CatalogSession, pr: CatalogPullRequest?, repository: String, busy: Boolean): List<Action> {
            if (repository.isEmpty() || busy) return emptyList()
            val dirty = session.workspaceDirty
            if (pr == null) {
                // Create PR needs anything to base a PR on, committed or not; Commit & Push needs uncommitted work.
                val changed = dirty || session.diffAdded + session.diffRemoved > 0
                return (if (changed) listOf(Action.CreatePr, Action.CreateDraftPr) else emptyList()) +
                    (if (dirty) listOf(Action.CommitAndPush) else emptyList())
            }
            if (pr.status == "merged" || pr.status == "closed") return emptyList()
            // Unpublished work outranks everything: the PR head is not the author's latest work.
            val actions = mutableListOf<Action>()
            if (dirty || session.workspaceUnpushed) actions += Action.CommitAndPush
            // A draft has no merge gate to clear; readiness is the user's call.
            if (pr.status == "draft") return actions + Action.ReadyForReview
            if (pr.merge == "d") actions += Action.ResolveConflicts
            if (pr.ci == "f" || pr.ci == "e") actions += Action.FixCi
            // Web `resolveSessionInfoBarGitHubActionIds`: Merge whenever GitHub would accept it, clean
            // or unstable (checks running or failing but not required). A demoted merge stays in the menu.
            if (pr.merge == "c" || pr.merge == "u") actions += Action.Merge
            return actions
        }
    }
}
