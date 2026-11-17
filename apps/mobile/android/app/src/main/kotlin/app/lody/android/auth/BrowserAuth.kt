package app.lody.android.auth

import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import org.json.JSONObject

internal const val NATIVE_CALLBACK = "lody://auth/mobile-callback"
enum class BrowserProvider(val wire: String) { GitHub("github"), Discord("discord"), Apple("apple") }
internal class PendingBrowserAuth(val state: String, val verifier: String, val createdAt: Long) {
    override fun toString() = "PendingBrowserAuth(<redacted>)"
    fun valid(now: Long) = now >= createdAt && now - createdAt < 600_000
    fun startUrl(provider: BrowserProvider): String {
        val challenge = encode(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        return "${app.lody.android.BackendEnvironment.site}/api/auth/mobile/start?provider=${provider.wire}&redirect_uri=lody%3A%2F%2Fauth%2Fmobile-callback&state=$state&code_challenge=$challenge&code_challenge_method=S256"
    }
    companion object {
        private fun opaque() = encode(ByteArray(32).also { SecureRandom().nextBytes(it) })
        fun create(now: Long) = PendingBrowserAuth(opaque(), opaque(), now)
    }
}
private fun encode(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
internal class BrowserCallback(val state: String, val code: String?) {
    override fun toString() = "BrowserCallback(<redacted>)"
    companion object {
        /** No normalized aliases, duplicate parameters, fragments, ports, userinfo or bearer data. */
        fun parse(raw: String): BrowserCallback? = try {
            require(raw.length <= 1024)
            val uri = URI(raw)
            require(uri.scheme == "lody" && uri.rawAuthority == "auth" && uri.rawPath == "/mobile-callback" && uri.rawFragment == null)
            val pairs = (uri.rawQuery ?: "").split('&').map { part ->
                val pieces = part.split('='); require(pieces.size == 2); pieces[0] to pieces[1]
            }
            require(pairs.map { it.first }.distinct().size == pairs.size)
            val values = pairs.toMap()
            val state = values["state"] ?: error("missing state")
            require(state.matches(Regex("[A-Za-z0-9_-]{43}")))
            val code = values["code"]
            if (code != null) {
                require(values.keys == setOf("state", "code") && code.matches(Regex("[A-Za-z0-9_-]{43}")))
            } else require(values.keys == setOf("state", "error") && values["error"] in setOf("oauth_failed", "access_denied"))
            BrowserCallback(state, code)
        } catch (_: Exception) { null }
    }
}

/** Reuses the encrypted noBackup Keystore boundary, with a separate alias from session credentials. */
internal class BrowserAuthStore(private val encrypted: CredentialStore) {
    suspend fun read(): PendingBrowserAuth? {
        val saved = encrypted.read() ?: return null
        return try {
            val json = JSONObject(String(Base64.getUrlDecoder().decode(saved.token), Charsets.UTF_8))
            val state = json.getString("state"); val verifier = json.getString("verifier")
            require(state.matches(Regex("[A-Za-z0-9_-]{43}")) && verifier.matches(Regex("[A-Za-z0-9_-]{43}")))
            PendingBrowserAuth(state, verifier, json.getLong("createdAt"))
        } catch (_: Exception) { encrypted.clear(); null }
    }
    suspend fun write(value: PendingBrowserAuth) {
        val json = JSONObject().put("state", value.state).put("verifier", value.verifier).put("createdAt", value.createdAt)
        encrypted.write(Credential(encode(json.toString().toByteArray(Charsets.UTF_8))))
    }
    suspend fun clear() = encrypted.clear()
}
