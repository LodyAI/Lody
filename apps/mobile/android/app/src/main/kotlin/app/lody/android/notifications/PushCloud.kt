package app.lody.android.notifications

import app.lody.android.auth.Credential
import app.lody.android.chat.GitHubHttp
import app.lody.android.chat.GitHubHttpClient
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

/** Public Convex protocol only. The credential is a BetterAuth session, never a CLI API key. */
internal class PushCloud(
    private val installation: String,
    private val language: () -> String,
    private val http: GitHubHttp = GitHubHttpClient(retryOnConnectionFailure = false),
) {
    fun session(credential: Credential): PushSession = object : PushSession {
        override suspend fun selfHosted(): Boolean {
            val value = call(credential, "query", "configuration", JSONObject()) as? JSONObject
            return value?.opt("selfHostedEnabled") as? Boolean
                ?: error("invalid_push_configuration")
        }
        override suspend fun register(token: String) = mutate {
            call(credential, "mutation", "register", JSONObject().put("installationId", installation).put("platform", "android")
                .put("purpose", "notification").put("token", token).put("language", language().take(32)))
        }
        override suspend fun unregister() = mutate {
            call(credential, "mutation", "unregister", JSONObject().put("installationId", installation))
        }
    }
    // Ordinary cancellation must not abandon a submitted mutation before cleanup.
    // A timeout still leaves remote commit unknown; this is not a server-side fence.
    private suspend fun mutate(block: suspend () -> Unit) = withContext(NonCancellable) {
        withTimeout(15_000) { block() }
    }
    private suspend fun call(credential: Credential, kind: String, method: String, args: JSONObject): Any? {
        fun expect(reply: Pair<Int, String>): JSONObject {
            check(reply.first in 200..299) { "push_request_failed" }
            return JSONObject(reply.second)
        }
        // The broker binds sessionId into this short-lived JWT. The backend validates
        // that live session again on registration and before each delivery.
        val jwt = expect(http.request("GET", "https://backend.lody.ai/api/auth/convex/token", credential.token, null)).getString("token")
        check(jwt.isNotBlank()) { "push_session_unavailable" }
        val reply = expect(http.request("POST", "https://convex.lody.ai/api/$kind", jwt,
            JSONObject().put("path", "pushSubscriptions:$method").put("format", "convex_encoded_json").put("args", JSONArray().put(args))))
        check(reply.optString("status") == "success") { "push_request_failed" }
        return reply.opt("value")
    }
}
