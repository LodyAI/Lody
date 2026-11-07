package app.lody.android.auth

/** Credential-free display context. It is never proof of authorization. */
data class AccountContext(val account: Account, val workspaceId: String? = null)
interface AccountContextStore {
    suspend fun readContext(): AccountContext?
    suspend fun saveAccount(account: Account)
    suspend fun clear()
}
