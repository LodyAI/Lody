package app.lody.android.auth

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.lody.android.R
import app.lody.android.designsystem.LodyTheme

@Composable
internal fun NativeSignInScreen(state: AuthState, account: AccountController, activity: Activity) {
    // Passwords are intentionally not saveable: no Bundle, disk, or process restoration.
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var register by remember { mutableStateOf(false) }
    var googleJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    DisposableEffect(activity) { onDispose { googleJob?.cancel() } }
    BackHandler(state.busy || state.browserPending) { account.cancel() }
    Column(Modifier.fillMaxSize().background(LodyTheme.colors.bgBase).safeDrawingPadding().imePadding()
        .verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Spacer(Modifier.height(32.dp))
        Text(stringResource(if (register) R.string.auth_register else R.string.sign_in_title), style = LodyTheme.typography.title, color = LodyTheme.colors.textPrimary)
        if (register) OutlinedTextField(name, { name = it.take(200) }, label = { Text(stringResource(R.string.auth_name)) }, singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(email, { email = it.take(254) }, label = { Text(stringResource(R.string.auth_email)) }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), enabled = !state.busy, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(password, { password = it.take(128) }, label = { Text(stringResource(R.string.auth_password)) }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), enabled = !state.busy, modifier = Modifier.fillMaxWidth())
        Button(onClick = { if (register) account.register(name, email, password) else account.login(email, password); password = "" },
            enabled = !state.busy && email.isNotBlank() && password.isNotEmpty() && (!register || name.isNotBlank()), modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(if (register) R.string.auth_register else R.string.sign_in_action))
        }
        TextButton(onClick = { register = !register; password = "" }, enabled = !state.busy) { Text(stringResource(if (register) R.string.auth_have_account else R.string.auth_register)) }
        TextButton(onClick = { account.requestReset(email) }, enabled = !state.busy && email.isNotBlank()) { Text(stringResource(R.string.auth_reset)) }
        TextButton(onClick = { account.sendVerification(email) }, enabled = !state.busy && email.isNotBlank()) { Text(stringResource(R.string.auth_verify)) }
        OutlinedButton(onClick = { googleJob = account.google { googleIdToken(activity, it) } }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.auth_google)) }
        for ((provider, label) in listOf(BrowserProvider.GitHub to R.string.auth_github, BrowserProvider.Discord to R.string.auth_discord, BrowserProvider.Apple to R.string.auth_apple)) {
            OutlinedButton(onClick = {
                account.browser(provider) { url ->
                    try { androidx.browser.customtabs.CustomTabsIntent.Builder().build().launchUrl(activity, android.net.Uri.parse(url)) }
                    catch (_: android.content.ActivityNotFoundException) { throw AuthFailure("browser_unavailable") }
                }
            }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(stringResource(label)) }
        }
        if (state.browserPending) Text(stringResource(R.string.auth_browser_pending), color = LodyTheme.colors.textSecondary)
        if (state.busy || state.browserPending) {
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            TextButton(onClick = { account.cancel() }) { Text(stringResource(R.string.sign_in_cancel)) }
        }
        state.notice?.let { Text(stringResource(when (it) { "verify_email" -> R.string.auth_verify_notice; else -> R.string.auth_email_sent }), color = LodyTheme.colors.textSecondary) }
        state.failure?.let { Text(stringResource(authError(it)), color = LodyTheme.colors.dangerDefault) }
    }
}

internal fun authError(code: String): Int = when (code) {
    "unsupported_local_reset" -> R.string.auth_unsupported_local_reset
    "invalid_credentials" -> R.string.auth_invalid_credentials
    "email_not_verified" -> R.string.auth_verify_notice
    "email_in_use" -> R.string.auth_email_in_use
    "invalid_email" -> R.string.auth_invalid_email
    "invalid_password" -> R.string.auth_invalid_password
    "rate_limited" -> R.string.auth_rate_limited
    "network_unavailable" -> R.string.auth_network
    "not_configured" -> R.string.auth_not_configured
    "login_cancelled", "access_denied" -> R.string.auth_cancelled
    "browser_unavailable" -> R.string.auth_browser_unavailable
    "google_unavailable" -> R.string.auth_google_unavailable
    "auth_expired", "credentials_unavailable" -> R.string.auth_expired
    else -> R.string.auth_failed
}
