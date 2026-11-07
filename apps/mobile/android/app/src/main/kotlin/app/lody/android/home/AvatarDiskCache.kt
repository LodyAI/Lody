package app.lody.android.home

import java.io.File
import java.security.MessageDigest

/** Public image bytes only. Call off the main thread; URL hashes keep paths bounded. */
internal class AvatarDiskCache(private val directory: File, private val maxBytes: Long = 16 * 1024 * 1024, private val maxEntries: Int = 128) {
    private fun file(url: String) = File(directory, MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).joinToString("") { "%02x".format(it) })

    @Synchronized fun isFresh(url: String): Boolean = file(url).let { it.isFile && System.currentTimeMillis() - it.lastModified() < 24 * 60 * 60 * 1000L }

    @Synchronized fun read(url: String): ByteArray? = runCatching {
        val file = file(url)
        if (!file.isFile || file.length() > minOf(maxBytes, 2 * 1024 * 1024)) return null
        file.readBytes()
    }.getOrNull()

    @Synchronized fun write(url: String, bytes: ByteArray) {
        if (bytes.isEmpty() || bytes.size > minOf(maxBytes, 2 * 1024 * 1024)) return
        runCatching {
            directory.mkdirs()
            val target = file(url)
            val temporary = File(directory, target.name + ".tmp")
            temporary.writeBytes(bytes)
            check(temporary.renameTo(target))
            val files = directory.listFiles()?.sortedByDescending { it.lastModified() }.orEmpty()
            var total = 0L
            files.forEachIndexed { index, file ->
                total += file.length()
                if (index >= maxEntries || total > maxBytes) file.delete()
            }
        }
    }
}
