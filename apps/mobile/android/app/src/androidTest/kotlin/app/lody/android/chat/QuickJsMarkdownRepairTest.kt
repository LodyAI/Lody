package app.lody.android.chat

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Runs the shipped `markdown/MarkdownRepair.js` asset in the real QuickJS engine. */
@RunWith(AndroidJUnit4::class)
class QuickJsMarkdownRepairTest {
    @Test
    fun repairsWithTheBundledRemend() = runBlocking {
        QuickJsMarkdownRepair.fromAssets(InstrumentationRegistry.getInstrumentation().targetContext).use { repair ->
            assertEquals("Use **bold**", repair.repair("Use **bold"))
            assertEquals("Call `x`", repair.repair("Call `x"))
            assertEquals("# Done\n", repair.repair("# Done\n"))
        }
    }

    @Test
    fun failsOpenWhenTheBundleIsBroken() = runBlocking {
        QuickJsMarkdownRepair { "throw new Error('broken')" }.use { repair ->
            assertEquals("**raw", repair.repair("**raw"))
        }
    }
}
