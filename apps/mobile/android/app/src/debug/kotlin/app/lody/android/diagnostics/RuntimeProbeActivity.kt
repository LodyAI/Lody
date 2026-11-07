package app.lody.android.diagnostics

import android.os.Bundle
import android.content.Intent
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.Lifecycle
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.lody.android.runtime.*

class RuntimeProbeActivity : ComponentActivity() {
    private val owner get() = (application as DebugLodyApplication).runtimeOwner
    private var scope by mutableStateOf<RuntimeScope?>(null)
    private var status by mutableStateOf(RuntimeStatus())
    private var checks by mutableStateOf<List<CapabilityCheck>>(emptyList())
    private var message by mutableStateOf("Starting bundled runtime…")
    private var testedGeneration = -1L
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                owner.state.collect { next ->
                    val changed = scope != next.scope
                    scope = next.scope; status = next.status
                    if (changed) { testedGeneration = -1L; checks = emptyList() }
                    if (status.phase == RuntimePhase.READY && "compatibility" in status.capabilities && testedGeneration != status.generation) {
                        testedGeneration = status.generation
                        runChecks()
                    }
                }
            }
        }
        setContent {
            val dark = androidx.compose.foundation.isSystemInDarkTheme()
            val colors = if (dark) darkColorScheme() else lightColorScheme()
            MaterialTheme(colorScheme = colors) {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        Text("WebView runtime", style = MaterialTheme.typography.headlineMedium)
                        Text("Offline compatibility lab", style = MaterialTheme.typography.titleMedium)
                        Text("Bundled Lody runtime · no login or cloud requests")
                        OutlinedButton(onClick = { startActivity(Intent(this@RuntimeProbeActivity, CloudProbeActivity::class.java)) }) { Text("Open cloud connection") }
                        HorizontalDivider()
                        Text("State: ${status.phase}", style = MaterialTheme.typography.titleMedium)
                        Text("Scope: ${scope?.workspaceId ?: "none"}")
                        Text("Generation ${status.generation} · Heartbeats ${status.acknowledgements} · Recoveries ${status.automaticRestarts}")
                        Text("WebView ${WebView.getCurrentWebViewPackage()?.versionName ?: "unavailable"}")
                        status.failure?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        Text(message)
                        checks.forEach { check ->
                            Text("${if (check.passed) "PASS" else "FAIL"}  ${check.name}",
                                color = if (check.passed) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error)
                        }
                        Button(onClick = { runChecks() }, enabled = status.phase == RuntimePhase.READY) { Text("Run compatibility checks") }
                        OutlinedButton(onClick = {
                            lifecycleScope.launch { (application as DebugLodyApplication).cloud.disconnect(); owner.activate(DebugLodyApplication.fixtureScope) }
                        }) { Text("Restart runtime") }
                        OutlinedButton(onClick = {
                            message = "JavaScript stalled; waiting for native watchdog…"
                            operate { (it as? DiagnosticCommands)?.stall() }
                        }, enabled = status.phase == RuntimePhase.READY) { Text("Test watchdog recovery") }
                        OutlinedButton(onClick = { lifecycleScope.launch { owner.clear(); message = "Stopped; pending calls cancelled" } }) { Text("Stop runtime") }
                        OutlinedButton(onClick = { startActivity(Intent(this@RuntimeProbeActivity, RuntimeDetailsActivity::class.java)) }) { Text("Open runtime details") }
                        OutlinedButton(onClick = {
                            lifecycleScope.launch {
                                val workspace = if (scope?.workspaceId == "workspace-a") "workspace-b" else "workspace-a"
                                owner.activate(RuntimeScope("offline-fixture", workspace))
                            }
                        }) { Text("Switch offline workspace") }
                        Text("Tests local JS/WASM and the native host only. Cloud CORS, authentication, synchronization and real sends are not validated.", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
    private fun operate(block: suspend (CloudRuntime) -> Unit) {
        val target = scope ?: return
        lifecycleScope.launch {
            try { owner.use(target, block) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: app.lody.android.runtime.RuntimeException) { message = "Runtime: ${error.fault.code}" }
        }
    }
    private fun runChecks() {
        message = "Running real WASM round trips…"
        operate { runtime ->
            val diagnostics = runtime as? DiagnosticCommands ?: return@operate
            val rows = diagnostics.checks()
            checks = rows
            message = "${rows.count { it.passed }}/${rows.size} checks passed"
        }
    }
}

class RuntimeDetailsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val owner = (application as DebugLodyApplication).runtimeOwner
        setContent {
            val state by owner.state.collectAsState()
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.safeDrawingPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text("Runtime details", style = MaterialTheme.typography.headlineMedium)
                        Text("${state.status.phase} · generation ${state.status.generation}")
                        Text("${state.scope?.workspaceId ?: "No active workspace"}")
                        Text("This page shares the application-owned runtime.")
                        Button(onClick = { finish() }) { Text("Back to checks") }
                    }
                }
            }
        }
    }
}
