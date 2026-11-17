package app.lody.android.cloud

import app.lody.android.BackendEnvironment
import app.lody.android.auth.Credential
import app.lody.android.chat.GitHubHttp
import app.lody.android.chat.GitHubHttpClient
import app.lody.android.runtime.RuntimeScope
import org.json.JSONObject

/**
 * iOS `SessionSharing.previewToken`: a preview-control proof's request token, minted by Lody Cloud
 * for the verified account. The intent must name the native scope's workspace, and the reply must
 * name this account as the requester. One-shot: a lost connection is never replayed.
 */
internal class PreviewTokens(private val http: GitHubHttp = GitHubHttpClient(retryOnConnectionFailure = false)) {
    class Failure(code: String) : Exception(code)

    /** The token, or the HTTP status (Int) the backend refused with. */
    suspend fun mint(credential: Credential, scope: RuntimeScope, intent: JSONObject): Any {
        if (intent.optString("workspaceId") != scope.workspaceId) throw Failure("workspace_changed")
        val (status, body) = http.request("POST", "${BackendEnvironment.site}/api/session-preview/request-token", credential.token, intent)
        if (status !in 200..299) return status
        val response = JSONObject(body)
        if (response.optString("requesterUserId") != scope.accountId) throw Failure("requester_mismatch")
        return response.optString("requestToken").ifEmpty { throw Failure("invalid_token") }
    }
}
