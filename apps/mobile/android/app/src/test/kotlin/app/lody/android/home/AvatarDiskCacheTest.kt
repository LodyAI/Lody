package app.lody.android.home

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class AvatarDiskCacheTest {
    @Test fun survivesRestartAndSeparatesUrls() {
        val directory = Files.createTempDirectory("avatars").toFile()
        try {
            AvatarDiskCache(directory).write("https://example.com/a", byteArrayOf(1, 2, 3))
            assertArrayEquals(byteArrayOf(1, 2, 3), AvatarDiskCache(directory).read("https://example.com/a"))
            assertNull(AvatarDiskCache(directory).read("https://example.com/b"))
        } finally { directory.deleteRecursively() }
    }
    @Test fun prunesOldestAndRejectsOversizedFiles() {
        val directory = Files.createTempDirectory("avatars").toFile()
        try {
            val cache = AvatarDiskCache(directory, maxBytes = 6, maxEntries = 2)
            cache.write("a", byteArrayOf(1, 2, 3))
            assertTrue(cache.isFresh("a"))
            directory.listFiles()!!.single().setLastModified(1)
            assertFalse(cache.isFresh("a"))
            assertArrayEquals(byteArrayOf(1, 2, 3), cache.read("a"))
            cache.write("b", byteArrayOf(4, 5, 6))
            cache.write("c", byteArrayOf(7, 8, 9))
            assertNull(cache.read("a"))
            assertArrayEquals(byteArrayOf(7, 8, 9), cache.read("c"))
            cache.write("large", ByteArray(7))
            assertNull(cache.read("large"))
        } finally { directory.deleteRecursively() }
    }
}
