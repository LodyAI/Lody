package app.lody.android.chat

import app.lody.android.auth.AccountController
import app.lody.android.runtime.RuntimeScope
import org.json.JSONArray
import org.json.JSONObject

internal data class MachineDetails(val ownerUserId: String?, val shared: Boolean?)

/** Public display metadata; the verified account fence keeps credentials out of Compose. */
internal class MachineDetailsReader(private val account: AccountController, private val http: GitHubHttp = GitHubHttpClient()) {
    suspend fun read(scope: RuntimeScope, machineId: String): MachineDetails? = account.withVerifiedAccount(scope) { credential ->
        fun body(response: Pair<Int, String>): JSONObject {
            check(response.first in 200..299) { "machine_details_unavailable" }
            return JSONObject(response.second)
        }
        val auth = body(http.request("GET", "${app.lody.android.BackendEnvironment.site}/api/auth/convex/token", credential.token, null))
        val token = (auth.opt("token") as? String)?.takeIf { it.isNotBlank() } ?: error("machine_details_unavailable")
        val response = body(http.request("POST", "${app.lody.android.BackendEnvironment.convex}/api/query", token,
            JSONObject().put("path", "machines:listVisibleMachines").put("format", "convex_encoded_json")
                .put("args", JSONArray().put(JSONObject().put("workspaceId", scope.workspaceId)))))
        check(response.optString("status") == "success") { "machine_details_unavailable" }
        val rows = response.optJSONArray("value") ?: return@withVerifiedAccount null
        (0 until rows.length()).asSequence().mapNotNull { rows.optJSONObject(it) }
            .firstOrNull { it.optString("machineId") == machineId }?.let {
                MachineDetails((it.opt("ownerUserId") as? String)?.takeIf(String::isNotBlank), it.opt("sharedWithTeam") as? Boolean)
            }
    }
}
