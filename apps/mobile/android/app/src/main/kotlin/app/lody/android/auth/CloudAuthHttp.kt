package app.lody.android.auth

import app.lody.android.runtime.ShortLivedGrant
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

internal class HttpReply(val status: Int, val body: String)
internal fun interface AuthTransport { suspend fun request(path: String, credential: Credential?, body: String?): HttpReply }
internal class CloudAuthHttp(private val pins: WorkspaceModePins, private val transport: AuthTransport) : CloudAuthApi {
    override fun workspaceMode(workspaceId: String) = pins.mode(workspaceId)
    private suspend fun request(path: String, credential: Credential? = null, body: JSONObject? = null, polling: Boolean = false): String {
        val reply = transport.request(path, credential, body?.toString())
        if (!polling && reply.status == 401) throw AuthFailure("auth_expired")
        if (reply.status !in 200..299 && !(polling && reply.status in 400..499)) throw AuthFailure("request_failed")
        return reply.body
    }
    private fun <T> decode(block: () -> T): T = try { block() } catch (_: Exception) { throw AuthFailure("invalid_auth_response") }
    private fun JSONObject.text(key: String): String = (get(key) as String).also { require(it.isNotBlank() && it.length <= 16384) }
    private fun JSONObject.seconds(key: String, maximum: Int): Int = (get(key) as Number).toInt().also { require(it in 1..maximum) }
    private suspend fun nativeRequest(path: String, body: JSONObject): JSONObject {
        val reply = transport.request(path, null, body.toString())
        if (reply.status !in 200..299) {
            val code = try { JSONObject(reply.body).optString("code") } catch (_: Exception) { "" }
            throw AuthFailure(when (code) {
                "INVALID_EMAIL_OR_PASSWORD", "INVALID_PASSWORD", "USER_NOT_FOUND" -> "invalid_credentials"
                "EMAIL_NOT_VERIFIED" -> "email_not_verified"
                "USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" -> "email_in_use"
                "PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG" -> "invalid_password"
                "INVALID_EMAIL" -> "invalid_email"
                else -> if (reply.status == 429) "rate_limited" else "request_failed"
            })
        }
        return decode { JSONObject(reply.body) }
    }
    private fun JSONObject.credential(): Credential = decode { Credential(text("token")) }
    override suspend fun exchange(code: String, verifier: String): Credential =
        nativeRequest("/api/auth/mobile/exchange", JSONObject().put("code", code).put("code_verifier", verifier).put("redirect_uri", NATIVE_CALLBACK)).credential()
    override suspend fun email(email: String, password: String): Credential =
        nativeRequest("/api/auth/sign-in/email", JSONObject().put("email", email).put("password", password).put("callbackURL", "${app.lody.android.BackendEnvironment.site}/api/auth/mobile/email-verified")).credential()
    override suspend fun register(name: String, email: String, password: String): Credential? {
        val data = nativeRequest("/api/auth/sign-up/email", JSONObject().put("name", name).put("email", email).put("password", password).put("callbackURL", "${app.lody.android.BackendEnvironment.site}/api/auth/mobile/email-verified"))
        return if (data.isNull("token") || !data.has("token")) {
            sendVerification(email)
            null
        } else data.credential()
    }
    override suspend fun google(idToken: String, nonce: String): Credential =
        nativeRequest("/api/auth/sign-in/social", JSONObject().put("provider", "google").put("idToken", JSONObject().put("token", idToken).put("nonce", nonce))).credential()
    override suspend fun sendVerification(email: String) {
        nativeRequest("/api/auth/send-verification-email", JSONObject().put("email", email).put("callbackURL", "${app.lody.android.BackendEnvironment.site}/api/auth/mobile/email-verified"))
    }
    override suspend fun requestReset(email: String) {
        if (app.lody.android.BackendEnvironment.site != "https://backend.lody.ai") throw AuthFailure("unsupported_local_reset")
        nativeRequest("/api/auth/request-password-reset", JSONObject().put("email", email).put("redirectTo", "https://lody.ai/reset-password"))
    }
    override suspend fun account(credential: Credential): Account {
        val session = request("/api/auth/get-session", credential)
        if (session == "null") throw AuthFailure("auth_expired")
        val workspaces = request("/api/auth/organization/list", credential)
        val account = decode {
            val user = JSONObject(session).getJSONObject("user")
            val list = JSONArray(workspaces)
            require(list.length() <= 1000)
            Account(
                user.text("id"),
                user.optString("name").ifBlank { "Lody account" },
                (0 until list.length()).map { list.getJSONObject(it).let { row -> Workspace(row.text("id"), row.text("name"), httpsImage(row.optString("logo")), row.optString("slug").takeIf { it.isNotBlank() && it != "null" },
                    if (row.optString("contentMode") == "e2ee" || !row.isNull("genesisHash")) WorkspaceContentMode.E2EE else WorkspaceContentMode.UNKNOWN,
                    row.optString("genesisHash").takeUnless { it.isBlank() || it == "null" }) } },
                httpsImage(user.optString("image")),
                user.optString("email").takeUnless { it == "null" }.orEmpty(),
            )
        }
        return account.copy(workspaces = workspaceModes(credential, account.workspaces))
    }
    override suspend fun workspaceModes(credential: Credential, workspaces: List<Workspace>): List<Workspace> {
        val rows = workspaces.map { row ->
            val mode = try { pins.observe(row.id, if (row.contentMode == WorkspaceContentMode.E2EE || row.genesisHash != null) WorkspaceContentMode.E2EE else WorkspaceContentMode.UNKNOWN, row.genesisHash) }
                catch (_: Exception) { pins.mode(row.id) }
            row.copy(contentMode = mode)
        }
        if (rows.all { it.contentMode == WorkspaceContentMode.E2EE }) return rows
        // One budget includes JWT acquisition, semaphore wait and each workspace query.
        return try { withTimeout(6000) {
            val auth = JSONObject(request("/api/auth/convex/token", credential))
            val bearer = Credential(auth.text("token"))
            val permits = Semaphore(4)
            coroutineScope {
                rows.map { row -> async {
                    if (row.contentMode == WorkspaceContentMode.E2EE) row
                    else permits.withPermit {
                        try {
                            val (mode, genesis) = describe(bearer, row.id)
                            currentCoroutineContext().ensureActive()
                            if (mode == WorkspaceContentMode.UNKNOWN) pins.rejectPlaintext(row.id)
                            row.copy(contentMode = pins.observe(row.id, mode, genesis), genesisHash = genesis ?: row.genesisHash)
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { row.copy(contentMode = pins.mode(row.id)) }
                    }
                } }.awaitAll()
            }
        } } catch (_: TimeoutCancellationException) { currentCoroutineContext().ensureActive(); rows.map { it.copy(contentMode = pins.mode(it.id)) } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { rows.map { it.copy(contentMode = pins.mode(it.id)) } }
    }
    private suspend fun describe(bearer: Credential, id: String): Pair<WorkspaceContentMode, String?> {
        val raw = request("/api/query", bearer, JSONObject().put("path", "e2eeWorkspaces:describe")
            .put("format", "convex_encoded_json").put("args", JSONArray().put(JSONObject().put("workspaceId", id))))
        return decode {
            val reply = JSONObject(raw)
            require(reply.getString("status") == "success")
            val value = reply.getJSONObject("value")
            require(value.getString("workspaceId") == id)
            val genesis = value.optString("genesisHash").takeUnless { it.isBlank() || it == "null" }
            val noCrypto = !value.has("genesisHash") && !value.has("cryptoOrgId")
            val mode = when {
                value.optString("contentMode") == "e2ee" || genesis != null -> WorkspaceContentMode.E2EE
                value.optString("contentMode") == "plaintext" && value.optInt("contentModeVersion") == 1 && noCrypto && !value.has("admission") -> WorkspaceContentMode.PLAINTEXT
                value.optString("admission") == "legacy-unclassified" && noCrypto && !value.has("contentMode") && !value.has("contentModeVersion") -> WorkspaceContentMode.PLAINTEXT
                else -> WorkspaceContentMode.UNKNOWN
            }
            mode to genesis
        }
    }
    override suspend fun grant(credential: Credential, workspaceId: String): ShortLivedGrant {
        if (pins.mode(workspaceId) != WorkspaceContentMode.PLAINTEXT) throw AuthFailure("workspace_mode_unconfirmed")
        val body = request("/api/loro-streams/token", credential, JSONObject().put("workspaceId", workspaceId))
        return decode {
            val data = JSONObject(body)
            ShortLivedGrant(data.text("token"), data.text("gatewayBaseUrl").trimEnd('/'), data.seconds("expiresIn", 3600))
        }
    }
    override suspend fun members(credential: Credential, workspaceId: String): List<WorkspaceMember> {
        require(workspaceId.matches(Regex("[A-Za-z0-9_-]{1,200}")))
        val result = linkedMapOf<String, WorkspaceMember>()
        var offset = 0
        while (offset < 10000) {
            val raw = request("/api/auth/organization/list-members?organizationId=$workspaceId&limit=100&offset=$offset", credential)
            val page = decode {
                val data = JSONObject(raw)
                val rows = data.getJSONArray("members")
                val total = data.getInt("total").also { require(it in 0..10000) }
                require(rows.length() <= 100)
                val members = (0 until rows.length()).map { index ->
                    val row = rows.getJSONObject(index)
                    val user = row.getJSONObject("user")
                    val id = row.text("userId")
                    require(user.text("id") == id)
                    WorkspaceMember(id, user.optString("name").takeUnless { it == "null" }.orEmpty(), httpsImage(user.optString("image")))
                }
                members to total
            }
            page.first.forEach { result[it.id] = it }
            offset += page.first.size
            if (offset >= page.second) return result.values.toList()
            if (page.first.isEmpty()) throw AuthFailure("incomplete_members")
        }
        throw AuthFailure("members_too_large")
    }
    override suspend fun signOut(credential: Credential) { request("/api/auth/sign-out", credential, JSONObject()) }
}
