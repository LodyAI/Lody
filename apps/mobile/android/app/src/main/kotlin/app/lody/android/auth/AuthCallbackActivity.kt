package app.lody.android.auth

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import app.lody.android.LodyApplication
import app.lody.android.home.HomeActivity
import kotlinx.coroutines.launch

/** Exported transport only. The application account owner validates and consumes the callback. */
class AuthCallbackActivity : ComponentActivity() {
    private var completion: kotlinx.coroutines.Job? = null
    @Suppress("DEPRECATION")
    override fun onRetainCustomNonConfigurationInstance(): Any? = completion
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val raw = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString
        // Do not retain authorization codes in Activity state or forward them to Home.
        intent = Intent()
        @Suppress("DEPRECATION")
        val retained = lastCustomNonConfigurationInstance as? kotlinx.coroutines.Job
        val account = (application as LodyApplication).account
        val job = retained ?: when {
            raw == null -> { finish(); return }
            BrowserCallback.parse(raw) != null -> account.browserCallback(raw)
            else -> { finish(); return }
        }
        completion = job
        lifecycleScope.launch {
            job.join()
            startActivity(Intent(this@AuthCallbackActivity, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            finish()
        }
    }
}
