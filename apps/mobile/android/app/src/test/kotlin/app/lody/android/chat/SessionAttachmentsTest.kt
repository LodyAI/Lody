package app.lody.android.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionAttachmentsTest {
    @Test fun textPreviewAcceptsUtf8EvenWhenTheProbeCutsACharacter() {
        val text = "日志 log ✓".toByteArray()
        assertTrue(SessionAttachmentUploads.textPreview(text))
        assertTrue("a cut multi-byte tail still counts", SessionAttachmentUploads.textPreview(text.copyOf(text.size - 1)))
    }

    @Test fun binaryPrefixesAreNotPreviewable() {
        assertFalse(SessionAttachmentUploads.textPreview(byteArrayOf(0x50, 0x4b, 0x03, 0x04, 0x00)))
        assertFalse(SessionAttachmentUploads.textPreview(byteArrayOf(0xff.toByte(), 0xfe.toByte(), 0xc3.toByte(), 0x28)))
    }

    @Test fun headerSegmentsArePercentEncoded() {
        assertEquals("my%20notes%E6%97%A5.md", SessionAttachmentUploads.segment("my notes日.md"))
    }
}
