package app.lody.android.runtime

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/** Process lifecycle, independently of any Activity or navigation destination. */
internal class RuntimeLifecycle(private val owner: RuntimeOwner, private val tasks: CoroutineScope,
 private val networks: Flow<Boolean>, private val recovered: () -> Unit) : DefaultLifecycleObserver {
 private var foreground = false
 private var networkAvailable = false
 init { tasks.launch { owner.setActive(false) }; observe() }
 private fun observe() { tasks.launch { networks.collect { networkAvailable = it; if (it && foreground) recovered() } } }
 override fun onStart(owner: LifecycleOwner) { foreground = true; tasks.launch { this@RuntimeLifecycle.owner.setActive(true); if (networkAvailable && foreground) recovered() } }
 override fun onStop(owner: LifecycleOwner) { foreground = false; tasks.launch { this@RuntimeLifecycle.owner.setActive(false) } }
}
