package app.lody.android.chat

import android.content.Context
import com.dokar.quickjs.QuickJs
import java.io.Closeable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/**
 * Presentation-only repair of a streaming Markdown reply: temporarily closes unfinished
 * syntax so raw markers do not flash. The original text stays the source of truth for
 * persistence and copy. Mirrors iOS `ChatMarkdownRepair`.
 */
fun interface MarkdownRepair {
    suspend fun repair(text: String): String

    companion object {
        val None = MarkdownRepair { it }
    }
}

/**
 * Runs the shared remend bundle (`shared/markdown-repair/entry.js`, built into the
 * `markdown/MarkdownRepair.js` asset) in QuickJS (quickjs-kt, which serializes
 * evaluations itself). The engine has no host bindings or network. Every failure
 * returns the input unchanged.
 */
class QuickJsMarkdownRepair(private val loadScript: () -> String) : MarkdownRepair, Closeable {
    private val setup = Mutex()
    private var engine: QuickJs? = null
    private var unavailable = false

    override suspend fun repair(text: String): String {
        val js = engine() ?: return text
        return try {
            // A JSON string is a valid JS string literal, so the text needs no other escaping.
            js.evaluate<String>("repairMarkdown(${JSONObject.quote(text)})", "repair.js")
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            text
        }
    }

    private suspend fun engine(): QuickJs? = setup.withLock {
        engine?.let { return it }
        if (unavailable) return null
        var created: QuickJs? = null
        try {
            created = QuickJs.create(Dispatchers.Default)
            created.memoryLimit = MEMORY_LIMIT_BYTES
            created.evaluate<Any?>(loadScript(), ASSET)
            engine = created
            created
        } catch (cancelled: CancellationException) {
            created?.close()
            throw cancelled
        } catch (error: Throwable) {
            created?.close()
            // Missing native library, missing asset or a bad bundle: render unrepaired text.
            unavailable = true
            null
        }
    }

    override fun close() {
        engine?.close()
        engine = null
    }

    companion object {
        const val ASSET = "markdown/MarkdownRepair.js"
        private const val MEMORY_LIMIT_BYTES = 32L shl 20

        fun fromAssets(context: Context): QuickJsMarkdownRepair {
            val app = context.applicationContext
            return QuickJsMarkdownRepair { app.assets.open(ASSET).bufferedReader().use { it.readText() } }
        }
    }
}
