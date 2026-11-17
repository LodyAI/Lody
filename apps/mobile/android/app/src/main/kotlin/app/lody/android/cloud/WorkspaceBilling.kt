package app.lody.android.cloud

import app.lody.android.BackendEnvironment
import app.lody.android.auth.Credential
import app.lody.android.chat.GitHubHttp
import app.lody.android.chat.GitHubHttpClient
import org.json.JSONArray
import org.json.JSONObject

/**
 * iOS `WorkspaceBilling`: the workspace's plan projection (`effectivePlanTier`, `checkoutPending`)
 * read with the verified account's Convex token. Only that projection reaches the runtime, which
 * applies the free-plan session and turn quotas. A failed read returns null, which fails open like
 * the other clients.
 */
internal class WorkspaceBilling(private val http: GitHubHttp = GitHubHttpClient()) {
    suspend fun entitlement(credential: Credential, workspaceId: String): JSONObject? {
        val (authStatus, authBody) = http.request("GET", "${BackendEnvironment.site}/api/auth/convex/token", credential.token, null)
        if (authStatus !in 200..299) return null
        val jwt = JSONObject(authBody).optString("token").ifEmpty { return null }
        val (status, body) = http.request("POST", "${BackendEnvironment.convex}/api/query", jwt,
            JSONObject().put("path", "billing:getWorkspaceBillingEntitlement").put("format", "convex_encoded_json")
                .put("args", JSONArray().put(JSONObject().put("workspaceId", workspaceId))))
        if (status !in 200..299) return null
        val response = JSONObject(body)
        if (response.optString("status") != "success") return null
        return project(response.optJSONObject("value"))
    }

    companion object {
        /** The validated projection, or null for anything else. */
        fun project(value: JSONObject?): JSONObject? {
            val tier = value?.opt("effectivePlanTier") as? String ?: return null
            val pending = value.opt("checkoutPending") as? Boolean ?: return null
            if (tier !in setOf("free", "plus", "enterprise")) return null
            return JSONObject().put("effectivePlanTier", tier).put("checkoutPending", pending)
        }
    }
}
