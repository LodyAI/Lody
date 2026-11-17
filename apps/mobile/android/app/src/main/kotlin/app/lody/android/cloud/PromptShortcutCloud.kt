package app.lody.android.cloud

import app.lody.android.BackendEnvironment
import app.lody.android.auth.Credential
import app.lody.android.chat.GitHubHttp
import app.lody.android.chat.GitHubHttpClient
import org.json.JSONArray
import org.json.JSONObject

/**
 * iOS `PromptShortcutCloud`: the four `promptShortcuts:*` Convex functions the shared runtime asks
 * for, with the verified account's session-bound Convex token. The workspace always comes from the
 * native scope. Mutations use a one-shot client so a lost connection is never replayed.
 */
internal class PromptShortcutCloud(
    private val reads: GitHubHttp = GitHubHttpClient(),
    private val writes: GitHubHttp = GitHubHttpClient(retryOnConnectionFailure = false),
) {
    class Failure(code: String) : Exception(code)

    suspend fun call(credential: Credential, workspaceId: String, operation: String, args: JSONObject): Any? {
        val kind = when (operation) {
            "listAccessibleDocuments" -> "query"
            "getStreamToken" -> "action"
            "stageDocument", "activateDocument" -> "mutation"
            else -> throw Failure("shortcut_unavailable")
        }
        val auth = JSONObject(expect(reads.request("GET", "${BackendEnvironment.site}/api/auth/convex/token", credential.token, null)))
        val jwt = auth.optString("token").ifEmpty { throw Failure("unauthorized") }
        val scoped = JSONObject(args.toString()).put("workspaceId", workspaceId)
        val http = if (kind == "mutation") writes else reads
        val response = JSONObject(expect(http.request("POST", "${BackendEnvironment.convex}/api/$kind", jwt,
            JSONObject().put("path", "promptShortcuts:$operation").put("format", "convex_encoded_json").put("args", JSONArray().put(scoped)))))
        if (response.optString("status") != "success") throw Failure("request_failed")
        return response.opt("value")
    }

    private fun expect(response: Pair<Int, String>): String {
        val (status, body) = response
        if (status in 200..299) return body
        throw Failure(if (status == 401) "unauthorized" else "request_failed")
    }
}
