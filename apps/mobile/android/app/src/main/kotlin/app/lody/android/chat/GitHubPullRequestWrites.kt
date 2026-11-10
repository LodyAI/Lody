package app.lody.android.chat

import app.lody.android.auth.Credential
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A failed GitHub write; [code] maps to copy (`not_mergeable`, `head_changed`, `merge_unknown`, …). */
class GitHubWriteFailure(val code: String) : Exception(code)

/** One HTTP exchange: status and body (bounded). A transport failure throws. */
internal fun interface GitHubHttp {
    suspend fun request(method: String, url: String, token: String, body: JSONObject?): Pair<Int, String>
}

/**
 * Web `useGitHubPrDetails` merge / ready for review, natively: Lody Cloud brokers a short-lived
 * write grant for the workspace's GitHub integration (the same broker as iOS `GitHubPullRequests`),
 * and the request goes straight to GitHub. Credentials and the grant never reach Compose or the
 * WebView. Merge pins the head it just read, so commits pushed meanwhile make GitHub refuse
 * instead of landing unseen work. Neither write is retried: a lost response may follow a
 * completed change, so it is reported as unknown.
 */
internal class GitHubPullRequestWrites(private val http: GitHubHttp = GitHubHttpClient()) {
    suspend fun merge(credential: Credential, workspace: String, repo: String, number: Int, method: String) {
        require(method in setOf("merge", "squash", "rebase")) { "invalid_request" }
        val token = grant(credential, workspace, repo, number)
        val base = "https://api.github.com/repos/$repo"
        val pr = open(read("$base/pulls/$number", token))
        if (pr.optBoolean("draft")) throw GitHubWriteFailure("not_mergeable")
        val sha = pr.optJSONObject("head")?.optString("sha").orEmpty()
        if (!sha.matches(Regex("[0-9a-fA-F]{7,64}"))) throw GitHubWriteFailure("invalid_response")
        val result = write("PUT", "$base/pulls/$number/merge", token, JSONObject().put("merge_method", method).put("sha", sha), "merge_unknown")
        if (!result.optBoolean("merged")) throw GitHubWriteFailure("not_mergeable")
    }

    suspend fun markReady(credential: Credential, workspace: String, repo: String, number: Int) {
        val token = grant(credential, workspace, repo, number)
        val pr = open(read("https://api.github.com/repos/$repo/pulls/$number", token))
        if (!pr.optBoolean("draft")) return
        val node = pr.optString("node_id").ifEmpty { throw GitHubWriteFailure("invalid_response") }
        val query = "mutation MarkReady(\$id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: \$id }) { pullRequest { isDraft } } }"
        val result = write("POST", "https://api.github.com/graphql", token, JSONObject().put("query", query).put("variables", JSONObject().put("id", node)), "ready_unknown")
        // GraphQL reports application errors with a 200.
        if ((result.optJSONArray("errors")?.length() ?: 0) > 0) throw GitHubWriteFailure("request_failed")
    }

    /** GitHub's merge state for an open PR (`c`, `b`, `d`, `h`, `u`), or null while it is computed. A read grant. */
    suspend fun mergeState(credential: Credential, workspace: String, repo: String, number: Int): String? {
        val token = grant(credential, workspace, repo, number, operation = "read")
        val pr = read("https://api.github.com/repos/$repo/pulls/$number", token)
        if (pr.optString("state") != "open" || pr.optBoolean("merged")) return null
        val mergeable = if (pr.has("mergeable") && !pr.isNull("mergeable")) pr.optBoolean("mergeable") else null
        val state = if (pr.isNull("mergeable_state")) null else pr.optString("mergeable_state")
        return PullRequestMergeSettle.code(state, mergeable, pr.optBoolean("draft"))
    }

    private suspend fun grant(credential: Credential, workspace: String, repo: String, number: Int, operation: String = "write"): String {
        if (!repo.matches(Regex("[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}")) || repo.substringAfter('/') in listOf(".", "..") || number <= 0) {
            throw GitHubWriteFailure("invalid_request")
        }
        val auth = JSONObject(expect(http.request("GET", "${app.lody.android.BackendEnvironment.site}/api/auth/convex/token", credential.token, null), null))
        val broker = JSONObject(expect(http.request("POST", "${app.lody.android.BackendEnvironment.convex}/api/action", auth.getString("token"),
            JSONObject().put("path", "github:getOperationAccessTokenByRepoNameForClient").put("format", "convex_encoded_json")
                .put("args", JSONArray().put(JSONObject().put("workspaceId", workspace).put("repoFullName", repo).put("operation", operation)))), null))
        val value = broker.optJSONObject("value")
        if (broker.optString("status") != "success" || value?.optBoolean("success") != true) throw GitHubWriteFailure("authorization_required")
        return value.optString("token").ifEmpty { throw GitHubWriteFailure("authorization_required") }
    }

    private fun open(pr: JSONObject): JSONObject {
        if (pr.optString("state") != "open" || pr.optBoolean("merged")) throw GitHubWriteFailure("not_open")
        return pr
    }

    private suspend fun read(url: String, token: String): JSONObject =
        JSONObject(expect(try { http.request("GET", url, token, null) } catch (_: java.io.IOException) { throw GitHubWriteFailure("unavailable") }, null))

    private suspend fun write(method: String, url: String, token: String, body: JSONObject, unknown: String): JSONObject {
        val response = try { http.request(method, url, token, body) } catch (_: java.io.IOException) { throw GitHubWriteFailure(unknown) }
        return JSONObject(expect(response, unknown))
    }

    /** GitHub merge: 405 not mergeable, 409 the head moved since it was read. */
    private fun expect(response: Pair<Int, String>, unknown: String?): String {
        val (status, body) = response
        throw GitHubWriteFailure(
            when {
                status in 200..299 -> return body
                status == 401 -> "unauthorized"
                status == 403 -> "forbidden"
                status == 404 -> "not_found"
                status == 405 -> "not_mergeable"
                status == 409 -> "head_changed"
                status == 429 -> "rate_limited"
                status >= 500 && unknown != null -> unknown
                else -> "request_failed"
            },
        )
    }
}

internal class GitHubHttpClient(private val retryOnConnectionFailure: Boolean = true) : GitHubHttp {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(retryOnConnectionFailure)
        .connectTimeout(15, TimeUnit.SECONDS).callTimeout(25, TimeUnit.SECONDS).build()

    override suspend fun request(method: String, url: String, token: String, body: JSONObject?): Pair<Int, String> = suspendCancellableCoroutine { continuation ->
        val payload = body?.toString()?.toRequestBody("application/json".toMediaType())
        val requestBody = if (!retryOnConnectionFailure && payload != null) object : RequestBody() {
            override fun contentType() = payload.contentType()
            override fun contentLength() = payload.contentLength()
            override fun isOneShot() = true // Also forbid status-based automatic mutation replay.
            override fun writeTo(sink: okio.BufferedSink) = payload.writeTo(sink)
        } else payload
        val request = Request.Builder().url(url).header("Authorization", "Bearer $token").header("Accept", "application/vnd.github+json").apply {
            if (url.startsWith("https://api.github.com/")) header("X-GitHub-Api-Version", "2022-11-28")
            method(method, requestBody)
        }.build()
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: java.io.IOException) { continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) {
                try {
                    val result = response.use {
                        val source = it.body.source()
                        source.request(1024 * 1024 + 1L)
                        if (source.buffer.size > 1024 * 1024) throw GitHubWriteFailure("response_limit")
                        it.code to source.buffer.readUtf8()
                    }
                    continuation.resume(result)
                } catch (error: Exception) { continuation.resumeWithException(error) }
            }
        })
    }
}
