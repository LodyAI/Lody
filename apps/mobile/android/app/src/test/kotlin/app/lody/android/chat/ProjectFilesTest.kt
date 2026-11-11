package app.lody.android.chat

import app.lody.android.runtime.CatalogSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProjectFilesTest {
    private fun session(projectId: String, archived: Boolean = false) =
        CatalogSession("s", "m", projectId, "Docs", "idle", archived, false, "2026-11-11T00:00:00Z")

    @Test fun onlyLiveLocalProjectConversationsOfferBrowseFiles() {
        assertTrue(ProjectFiles.browsable(session("m:local:project-1"), creating = false))
        assertFalse(ProjectFiles.browsable(session("m:local:project-1"), creating = true))
        assertFalse(ProjectFiles.browsable(session("m:local:project-1", archived = true), creating = false))
        assertFalse(ProjectFiles.browsable(session("github:owner/repo"), creating = false))
        assertFalse(ProjectFiles.browsable(session(":local:project-1"), creating = false))
        assertFalse(ProjectFiles.browsable(session("m:local:"), creating = false))
        assertFalse(ProjectFiles.browsable(null, creating = false))
    }

    @Test fun markdownFilesOpenAndOthersStayListed() {
        assertTrue(ProjectFiles.isMarkdown("README.md"))
        assertTrue(ProjectFiles.isMarkdown("docs/Guide.MARKDOWN"))
        assertTrue(ProjectFiles.isMarkdown("page.mdx"))
        assertFalse(ProjectFiles.isMarkdown("main.kt"))
        assertFalse(ProjectFiles.isMarkdown("md"))
        assertFalse(ProjectFiles.isMarkdown("notes.md/readme"))
        assertEquals("README.md", ProjectFiles.join("", "README.md"))
        assertEquals("docs/a.md", ProjectFiles.join("docs", "a.md"))
    }

    @Test fun relativeMarkdownLinksResolveInsideTheProjectOnly() {
        assertEquals("docs/setup.md", ProjectFiles.linkedMarkdown("docs/index.md", "setup.md#install"))
        assertEquals("README.md", ProjectFiles.linkedMarkdown("docs/index.md", "../README.md"))
        assertEquals("docs/guides/My Guide.md", ProjectFiles.linkedMarkdown("docs/index.md", "./guides/My%20Guide.md?plain=1"))
        assertNull(ProjectFiles.linkedMarkdown("README.md", "../outside.md"))
        assertNull(ProjectFiles.linkedMarkdown("README.md", "/etc/notes.md"))
        assertNull(ProjectFiles.linkedMarkdown("README.md", "https://example.com/a.md"))
        assertNull(ProjectFiles.linkedMarkdown("README.md", "mailto:someone@example.com"))
        assertNull(ProjectFiles.linkedMarkdown("README.md", "src/main.kt"))
        assertNull(ProjectFiles.linkedMarkdown("README.md", "#section"))
    }
}
