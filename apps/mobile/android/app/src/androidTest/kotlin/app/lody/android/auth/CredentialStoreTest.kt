package app.lody.android.auth
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File
class CredentialStoreTest {
 @Test fun persistsEncryptedCredentialAndClearsItOnLogout()=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val store=KeystoreCredentialStore(context,"verification-auth")
  store.clear()
  try {
   store.write(Credential("fixture-secret-credential"))
   assertEquals("fixture-secret-credential",KeystoreCredentialStore(context,"verification-auth").read()?.token)
   assertFalse(File(context.noBackupFilesDir,"verification-auth.enc").readBytes().toString(Charsets.UTF_8).contains("fixture-secret-credential"))
   store.clear();assertNull(store.read())
  } finally {store.clear()}
 }
 @Test fun tamperedCiphertextRequiresLoginAndRemovesUnreadableState()=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val store=KeystoreCredentialStore(context,"verification-tamper")
  try {
   store.write(Credential("fixture"))
   val file=File(context.noBackupFilesDir,"verification-tamper.enc")
   file.writeBytes(byteArrayOf(1,2,3))
   try {store.read();fail()}catch(e:AuthFailure){assertEquals("credentials_unavailable",e.code)}
   assertNull(store.read());assertFalse(file.exists())
  } finally {store.clear()}
 }
}
