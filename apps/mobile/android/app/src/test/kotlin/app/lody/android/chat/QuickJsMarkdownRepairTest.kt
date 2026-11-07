package app.lody.android.chat

import java.io.File
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/** Runs the shipped `markdown/MarkdownRepair.js` (built by `generateRuntimeAssets`) in the JVM QuickJS engine. */
class QuickJsMarkdownRepairTest {
    private val bundle = File(checkNotNull(System.getProperty("markdown.repair")) { "markdown.repair not set" })

    @Test
    fun repairsWithTheBundledRemend() = runBlocking {
        QuickJsMarkdownRepair { bundle.readText() }.use { repair ->
            assertEquals("Use **bold**", repair.repair("Use **bold"))
            assertEquals("Call `x`", repair.repair("Call `x"))
            assertEquals("See docs", repair.repair("See [docs"))
            assertEquals("# Done\n", repair.repair("# Done\n"))
            // Quotes, backslashes, newlines and line separators survive the JS string literal.
            val tricky = "a \"q\" \\ \n b \u2028 c 中文 \t end"
            assertEquals(tricky, repair.repair(tricky))
        }
    }

    @Test
    fun servesConcurrentCallers() = runBlocking {
        QuickJsMarkdownRepair { bundle.readText() }.use { repair ->
            val results = (1..32).map { i -> async { repair.repair("**$i") } }.awaitAll()
            assertEquals((1..32).map { "**$it**" }, results)
        }
    }

    @Test
    fun failsOpenWhenTheBundleIsBroken() = runBlocking {
        QuickJsMarkdownRepair { "throw new Error('broken')" }.use { repair ->
            assertEquals("**raw", repair.repair("**raw"))
            assertEquals("**raw", repair.repair("**raw"))
        }
    }
}
