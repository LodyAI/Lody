package app.lody.android.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class KeystoreCredentialStore(context: Context, name: String = "account") : CredentialStore {
    init { require(name.matches(Regex("[a-zA-Z0-9_-]+"))) }
    private val file = AtomicFile(File(context.noBackupFilesDir, "$name${app.lody.android.BackendEnvironment.storageSuffix}.enc"))
    private val alias = "${context.packageName}.$name${app.lody.android.BackendEnvironment.storageSuffix}.v1"
    private val associatedData = alias.toByteArray()
    private fun key(create: Boolean): SecretKey? {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!create) return null
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    override suspend fun read(): Credential? = withContext(Dispatchers.IO) {
        if (!file.baseFile.exists()) return@withContext null
        try {
            require(file.baseFile.length() in 30..20000)
            val bytes = file.readFully()
            require(bytes[0] == 1.toByte())
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(false) ?: throw IllegalStateException(), GCMParameterSpec(128, bytes.copyOfRange(1,13)))
            cipher.updateAAD(associatedData)
            Credential(cipher.doFinal(bytes.copyOfRange(13,bytes.size)).toString(Charsets.UTF_8))
        } catch (_: Exception) {
            file.delete()
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) }
            throw AuthFailure("credentials_unavailable")
        }
    }
    override suspend fun write(credential: Credential) = withContext(Dispatchers.IO) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(true)); cipher.updateAAD(associatedData)
        val bytes = byteArrayOf(1) + cipher.iv + cipher.doFinal(credential.token.toByteArray())
        val output = file.startWrite()
        try { output.write(bytes); file.finishWrite(output) }
        catch (_: Exception) { file.failWrite(output); throw AuthFailure("credential_save_failed") }
    }
    override suspend fun clear() = withContext(Dispatchers.IO) {
        file.delete()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) }
        Unit
    }
}
