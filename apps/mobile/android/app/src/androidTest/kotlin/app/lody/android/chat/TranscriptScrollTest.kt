package app.lody.android.chat

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.os.SystemClock
import app.lody.android.designsystem.LodyTheme
import app.lody.android.diagnostics.CreateSessionProbeActivity
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TranscriptScrollTest {
    @Test fun delayedTranscriptStartsAtEndAndFollowsViewportChanges() {
        val entries = mutableStateOf(emptyList<ChatEntry>())
        val height = mutableStateOf(600)
        val jump = mutableStateOf(0)
        lateinit var list: LazyListState
        ActivityScenario.launch(CreateSessionProbeActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    list = remember { LazyListState() }
                    LodyTheme {
                        Box(Modifier.fillMaxWidth().height(height.value.dp)) {
                            ChatTranscript(entries.value, state = list, scrollToLatest = jump.value)
                        }
                    }
                }
            }
            SystemClock.sleep(300)
            scenario.onActivity {
                entries.value = (0 until 100).map { ChatEntry.User("row-$it", "Message $it\n".repeat(5), TurnIdentity("Fixture"), Delivery.Sent) }
            }
            fun assertAtEnd(label: String) {
                val deadline = SystemClock.uptimeMillis() + 5_000
                var more = true
                while (SystemClock.uptimeMillis() < deadline) {
                    scenario.onActivity { more = list.layoutInfo.totalItemsCount == 0 || list.canScrollForward }
                    if (!more) break
                    SystemClock.sleep(50)
                }
                assertFalse(label, more)
            }
            assertAtEnd("First asynchronous transcript must open at its end")
            scenario.onActivity { height.value = 280 }
            SystemClock.sleep(200)
            assertAtEnd("Keyboard/composer resize must retain the bottom anchor")
            scenario.onActivity { entries.value = entries.value + ChatEntry.User("tail", "New message\n".repeat(15), TurnIdentity("Fixture"), Delivery.Sent) }
            SystemClock.sleep(200)
            assertAtEnd("A new tall tail must remain fully visible")
            // A genuine touch drag pauses following. Neither new content nor a viewport
            // resize may pull a reader away from older messages; the explicit jump resumes it.
            InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
                "input swipe 500 150 500 600 400",
            ).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
            SystemClock.sleep(500)
            scenario.onActivity { assertTrue("Drag must leave the tail", list.canScrollForward) }
            scenario.onActivity {
                entries.value = entries.value + ChatEntry.User("later", "Later message", TurnIdentity("Fixture"), Delivery.Sent)
                height.value = 220
            }
            SystemClock.sleep(500)
            scenario.onActivity { assertTrue("Reading position must survive content and viewport changes", list.canScrollForward) }
            scenario.onActivity { jump.value++ }
            SystemClock.sleep(200)
            assertAtEnd("Explicit jump resumes following")
        }
    }
}
