package app.lody.android.runtime

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RuntimeLifecycleTest {
 @Test fun backgroundTransitionsDoNotRegisterAgainOrRecoverUntilForeground() = runTest {
  val network = MutableSharedFlow<Boolean>()
  var recoveries = 0
  val owner = RuntimeOwner({error("unused")}, StandardTestDispatcher(testScheduler))
  val lifecycle = RuntimeLifecycle(owner, backgroundScope, network) {recoveries++}
  val host = object:LifecycleOwner {override val lifecycle:Lifecycle get()=error("unused")}
  runCurrent()
  lifecycle.onStart(host);runCurrent();network.emit(true);runCurrent();assertEquals(1,recoveries)
  repeat(3) { index -> lifecycle.onStop(host);runCurrent();network.emit(true);runCurrent();assertEquals(1+index,recoveries);lifecycle.onStart(host);runCurrent()}
  assertEquals(4, recoveries)
  assertEquals(1, network.subscriptionCount.value)
  network.emit(true);runCurrent();assertEquals(5,recoveries)
 }
 @Test fun networkRestoredInBackgroundIsRetriedOnlyOnReturn()=runTest {
  val network=MutableSharedFlow<Boolean>();var recovered=0
  val lifecycle=RuntimeLifecycle(RuntimeOwner({error("unused")},StandardTestDispatcher(testScheduler)),backgroundScope,network){recovered++}
  val host=object:LifecycleOwner{override val lifecycle:Lifecycle get()=error("unused")}
  runCurrent();network.emit(true);runCurrent();assertEquals(0,recovered)
  lifecycle.onStart(host);runCurrent();assertEquals(1,recovered)
 }

}
