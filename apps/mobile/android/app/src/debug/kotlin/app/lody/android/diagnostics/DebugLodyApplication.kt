package app.lody.android.diagnostics

import app.lody.android.LodyApplication
import app.lody.android.runtime.*
import kotlinx.coroutines.launch

class DebugLodyApplication : LodyApplication() {
    companion object { val fixtureScope = RuntimeScope("offline-fixture", "workspace-a") }
    override fun createOfflineRuntime(scope: RuntimeScope): CloudRuntime = DiagnosticRuntime(this, scope)
    override fun onCreate() {
        super.onCreate()
        applicationScope.launch { runtimeOwner.activate(fixtureScope) }
    }
}
