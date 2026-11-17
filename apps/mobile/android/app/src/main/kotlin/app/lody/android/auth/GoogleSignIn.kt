package app.lody.android.auth

import android.app.Activity
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.CustomCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import app.lody.android.BuildConfig
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

/** The Activity is retained only while its native credential sheet is active. */
internal suspend fun googleIdToken(activity: Activity, nonce: String): String {
    if (BuildConfig.GOOGLE_WEB_CLIENT_ID.isBlank()) throw AuthFailure("not_configured")
    try {
        val option = GetSignInWithGoogleOption.Builder(BuildConfig.GOOGLE_WEB_CLIENT_ID).setNonce(nonce).build()
        val result = CredentialManager.create(activity).getCredential(activity, GetCredentialRequest.Builder().addCredentialOption(option).build()).credential
        if (result !is CustomCredential || result.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) throw AuthFailure("invalid_auth_response")
        return GoogleIdTokenCredential.createFrom(result.data).idToken
    } catch (_: GetCredentialCancellationException) {
        throw AuthFailure("login_cancelled")
    } catch (_: GetCredentialException) {
        throw AuthFailure("google_unavailable")
    }
}
