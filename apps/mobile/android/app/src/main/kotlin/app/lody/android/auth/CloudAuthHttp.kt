package app.lody.android.auth

import app.lody.android.runtime.ShortLivedGrant
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

internal class HttpReply(val status: Int, val body: String)
internal fun interface AuthTransport { suspend fun request(path: String, credential: Credential?, body: String?): HttpReply }
internal class CloudAuthHttp(private val transport: AuthTransport) : CloudAuthApi {
    private suspend fun request(path: String, credential: Credential? = null, body: JSONObject? = null, polling: Boolean = false): String {
        val reply = transport.request(path, credential, body?.toString())
        if (!polling && reply.status == 401) throw AuthFailure("auth_expired")
        if (reply.status !in 200..299 && !(polling && reply.status in 400..499)) throw AuthFailure("request_failed")
        return reply.body
    }
    private fun <T> decode(block: () -> T): T = try { block() } catch (_: Exception) { throw AuthFailure("invalid_auth_response") }
    private fun JSONObject.text(key: String): String = (get(key) as String).also { require(it.isNotBlank() && it.length <= 16384) }
    private fun JSONObject.seconds(key: String, maximum: Int): Int = (get(key) as Number).toInt().also { require(it in 1..maximum) }
    override suspend fun authorize(): DeviceAuthorization {
        val body = request("/api/auth/device/code", body = JSONObject().put("client_id", "lody-cli"))
        return decode {
            val data = JSONObject(body)
            val uri = URI(data.text("verification_uri_complete"))
            require(uri.scheme == "https" && uri.host in setOf("lody.ai", "backend.lody.ai") && uri.userInfo == null && uri.port == -1 && uri.fragment == null)
            val official = "https://lody.ai" + uri.rawPath + (uri.rawQuery?.let { "?$it" } ?: "")
            DeviceAuthorization(data.text("device_code"), data.text("user_code"), official, data.seconds("expires_in", 3600), data.seconds("interval", 60))
        }
    }
    override suspend fun poll(code: DeviceAuthorization): TokenPoll {
        val body = request("/api/auth/device/token", body = JSONObject().put("client_id", "lody-cli").put("device_code", code.deviceCode).put("grant_type", "urn:ietf:params:oauth:grant-type:device_code"), polling = true)
        return decode {
            val data = JSONObject(body)
            if (data.has("access_token")) TokenPoll.Authorized(Credential(data.text("access_token")))
            else when (data.text("error")) {
                "authorization_pending" -> TokenPoll.Pending
                "slow_down" -> TokenPoll.SlowDown
                "access_denied" -> TokenPoll.Denied
                "expired_token" -> TokenPoll.Expired
                else -> throw IllegalArgumentException()
            }
        }
    }
    override suspend fun account(credential: Credential): Account {
        val session = request("/api/auth/get-session", credential)
        if (session == "null") throw AuthFailure("auth_expired")
        val workspaces = request("/api/auth/organization/list", credential)
        return decode {
            val user = JSONObject(session).getJSONObject("user")
            val list = JSONArray(workspaces)
            require(list.length() <= 1000)
            Account(
                user.text("id"),
                user.optString("name").ifBlank { "Lody account" },
                (0 until list.length()).map { list.getJSONObject(it).let { row -> Workspace(row.text("id"), row.text("name"), httpsImage(row.optString("logo"))) } },
                httpsImage(user.optString("image")),
            )
        }
    }
    override suspend fun grant(credential: Credential, workspaceId: String): ShortLivedGrant {
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
