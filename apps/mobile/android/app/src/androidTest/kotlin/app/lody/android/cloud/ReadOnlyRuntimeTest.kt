package app.lody.android.cloud
import androidx.test.platform.app.InstrumentationRegistry
import app.lody.android.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger
import android.webkit.WebView
import androidx.webkit.WebViewCompat
class ReadOnlyRuntimeTest {
 @Test fun networkDocumentNegotiatesOnlyReadCommandsAndStopsPendingGrantRefresh()=runBlocking {
  val requested=CompletableDeferred<Unit>();val cancelled=CompletableDeferred<Unit>()
  val provider=GrantProvider {requested.complete(Unit);try {awaitCancellation()} finally {cancelled.complete(Unit)}}
  val runtime=withContext(Dispatchers.Main){ReadOnlyCloudRuntime(InstrumentationRegistry.getInstrumentation().targetContext,RuntimeScope("fixture","workspace"),ShortLivedGrant("fixture","https://streams.example.org",60),provider)}
  try {
   runtime.start();val ready=withTimeout(15000){runtime.state.first{it.phase==RuntimePhase.READY}}
   assertTrue(ready.capabilities.containsAll(setOf("connect","grant")));assertFalse(ready.capabilities.contains("sendTurn"))
   delay(300);runtime.setActive(false);runtime.setActive(true)
   withTimeout(10000){requested.await()};runtime.stop();withTimeout(5000){cancelled.await()}
   assertEquals(RuntimePhase.STOPPED,runtime.state.value.phase)
  } finally {runtime.stop()}
 }
 @Test fun newGenerationRetriesTransientGrantFailureWithoutForegroundCycling()=runBlocking {
  val calls=AtomicInteger();val recovered=CompletableDeferred<Unit>()
  val provider=GrantProvider {
   if(calls.incrementAndGet()==1)throw RuntimeException(RuntimeFault("network_unavailable",RuntimeErrorCategory.NETWORK))
   recovered.complete(Unit);ShortLivedGrant("fixture","https://streams.example.org",60)
  }
  val runtime=withContext(Dispatchers.Main){ReadOnlyCloudRuntime(InstrumentationRegistry.getInstrumentation().targetContext,RuntimeScope("fixture","workspace"),ShortLivedGrant("fixture","https://streams.example.org",60),provider)}
  try {
   runtime.start();withTimeout(15000){runtime.state.first{it.phase==RuntimePhase.READY}}
   withContext(Dispatchers.Main) {
    val facade=ReadOnlyCloudRuntime::class.java.getDeclaredField("runtime").apply{isAccessible=true}.get(runtime) as WebViewRuntime
    val view=WebViewCloudRuntime::class.java.getDeclaredField("view").apply{isAccessible=true}.get(facade.backend) as WebView
    assertTrue(WebViewCompat.getWebViewRenderProcess(view)!!.terminate())
   }
   withTimeout(10000){recovered.await()}
   assertTrue(calls.get()>=2)
  } finally {runtime.stop()}
 }

 @Test fun expiredInitialGrantIsReplacedBeforeFirstConnect()=runBlocking {
  val requested=CompletableDeferred<Unit>()
  val runtime=withContext(Dispatchers.Main){ReadOnlyCloudRuntime(InstrumentationRegistry.getInstrumentation().targetContext,RuntimeScope("fixture","workspace"),ShortLivedGrant("expired","https://streams.example.org",60,receivedAtNanos=System.nanoTime()-120_000_000_000L),GrantProvider {requested.complete(Unit);awaitCancellation()})}
  try {runtime.start();withTimeout(15000){requested.await()}}
  finally {runtime.stop()}
 }

}
