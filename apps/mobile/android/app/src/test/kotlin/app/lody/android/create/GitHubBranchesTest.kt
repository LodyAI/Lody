package app.lody.android.create

import app.lody.android.auth.Credential
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class GitHubBranchesTest {
    @Test fun credentialsOnlyGoToTheirAudienceAndDefaultIsIncluded() = runTest {
        val calls = mutableListOf<Pair<String, String>>()
        val api = GitHubBranches { url, token, body ->
            calls += url to token
            when {
                url.contains("/convex/token") -> """{"token":"jwt"}"""
                url.contains("convex.lody.ai") -> {
                    assertEquals("workspace", body!!.getJSONArray("args").getJSONObject(0).getString("workspaceId"))
                    """{"status":"success","value":{"success":true,"token":"repo-token"}}"""
                }
                url.contains("/branches?") -> """[{"name":"feature"}]"""
                else -> """{"default_branch":"main"}"""
            }
        }
        val result = api.load(Credential("login"), "workspace", "Owner/Repo", 1)
        assertEquals(listOf("feature", "main"), result.names)
        assertEquals(listOf("login", "jwt", "repo-token", "repo-token"), calls.map { it.second })
        assertEquals(listOf("backend.lody.ai", "convex.lody.ai", "api.github.com", "api.github.com"), calls.map { java.net.URI(it.first).host })
        assertNull(result.nextPage)
    }
    @Test fun invalidRepositoryIsRejectedBeforeNetwork() = runTest {
        var requests = 0
        val api = GitHubBranches { _, _, _ -> requests++; error("unexpected") }
        for (repo in listOf("Owner/..", "Owner/Repo?token=x", "https://evil.test", "Owner/Repo/extra")) {
            try { api.load(Credential("login"), "workspace", repo, 1); fail() } catch (_: IllegalArgumentException) { }
        }
        assertEquals(0, requests)
    }
}
