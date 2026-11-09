package app.lody.android.diagnostics

import app.lody.android.home.HomeActivity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.lody.android.LodyApplication
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class CloudProbeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as LodyApplication
        if (savedInstanceState == null && app.account.state.value.account == null && !app.account.state.value.busy) app.account.restore()
        setContent {
            val auth by app.account.state.collectAsState()
            val probe by app.cloud.state.collectAsState()
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text("Lody Cloud", style = MaterialTheme.typography.headlineMedium)
                        Text("Read-only connection probe", style = MaterialTheme.typography.titleMedium)
                        if (auth.account == null) {
                            Button(onClick = { startActivity(Intent(this@CloudProbeActivity, HomeActivity::class.java)) }) { Text("Open native sign-in") }
                            OutlinedButton(onClick = { app.account.restore() }, enabled = !auth.busy) { Text("Retry saved account") }
                        }
                        auth.account?.let { account ->
                            Text(account.name, style = MaterialTheme.typography.titleLarge)
                            if (!auth.verified) {
                                Text("Cached account · authorization not yet verified")
                                OutlinedButton(onClick = { app.account.restore() }, enabled = !auth.busy) { Text("Retry connection") }
                            }
                            Text("Choose a workspace")
                            if (account.workspaces.isEmpty()) Text("No accessible workspaces")
                            account.workspaces.forEach { workspace ->
                                OutlinedButton(onClick = { app.cloud.select(workspace) }, enabled = !auth.busy) { Text(workspace.name) }
                            }
                            Text("Connection: ${probe.phase}")
                            if (probe.cached) Text("Cached catalog · waiting for live synchronization")
                            if (probe.cacheFailure) Text("Local cache unavailable · cloud reads remain enabled")
                            probe.workspace?.let { Text(it.name) }
                            Text("Projects ${probe.projects} · Sessions ${probe.sessions} · Streams ${probe.streams}")
                            probe.failure?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                            OutlinedButton(onClick = { lifecycleScope.launch { app.cloud.disconnect() } }) { Text("Disconnect") }
                            OutlinedButton(onClick = { app.account.logout() }) { Text("Sign out") }
                        }
                        Text("This stage reads workspace catalogs only. Catalogs are cached locally. Sending is not enabled.", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
