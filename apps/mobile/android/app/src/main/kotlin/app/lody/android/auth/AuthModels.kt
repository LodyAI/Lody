package app.lody.android.auth

import app.lody.android.runtime.ShortLivedGrant

class Credential(val token: String) {
    init { require(token.isNotBlank() && token.length <= 16384 && token.all { it in '!'..'~' }) }
    override fun toString() = "Credential(<redacted>)"
}
/** [image] is the workspace logo (HTTPS only), null when it has none. */
data class WorkspaceMember(val id: String, val name: String, val image: String? = null)
data class Workspace(val id: String, val name: String, val image: String? = null, val slug: String? = null)
/** [image] is the user's avatar (HTTPS only), null when they have none. */
data class Account(val id: String, val name: String, val workspaces: List<Workspace>, val image: String? = null)

/** Avatar URLs are display data: keep only HTTPS, as iOS `AuthAPI.optionalHTTPS`. */
internal fun httpsImage(value: String?): String? =
    value?.trim()?.takeIf { it.length <= 2048 && it.startsWith("https://", ignoreCase = true) }
class AuthFailure(val code: String) : Exception(code)
interface CloudAuthApi {
    suspend fun exchange(code: String, verifier: String): Credential = throw AuthFailure("not_configured")
    suspend fun email(email: String, password: String): Credential = throw AuthFailure("not_configured")
    suspend fun register(name: String, email: String, password: String): Credential? = throw AuthFailure("not_configured")
    suspend fun google(idToken: String, nonce: String): Credential = throw AuthFailure("not_configured")
    suspend fun sendVerification(email: String) { throw AuthFailure("not_configured") }
    suspend fun requestReset(email: String) { throw AuthFailure("not_configured") }
    suspend fun account(credential: Credential): Account
    suspend fun grant(credential: Credential, workspaceId: String): ShortLivedGrant
    suspend fun members(credential: Credential, workspaceId: String): List<WorkspaceMember> = throw AuthFailure("members_unavailable")
    suspend fun signOut(credential: Credential)
}
interface CredentialStore {
    suspend fun read(): Credential?
    suspend fun write(credential: Credential)
    suspend fun clear()
}
