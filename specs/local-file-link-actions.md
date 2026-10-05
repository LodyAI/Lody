# Local file links and system actions

Status: draft
Translation: current

[中文](local-file-link-actions.zh.md)

When an assistant links to a local source file or build artifact, the user can
open it in the session's right-side preview. The inline link uses blue text and
a matching file-type icon, without a pill background or border. Hover and keyboard
focus remain visible, and line references retain their existing navigation behavior.
Clicking a link with a line reference opens the file and brings that line into view
on the first click, with a visible line-range highlight. Initial content loading,
language setup, and panel expansion must not require a second click. Clicking the
same link again returns to its referenced line after the user has scrolled elsewhere.

When Electron opens a conversation on its own machine, file links may preview any
readable regular local file, including files outside the session workspace and in
another worktree. Worktree prefixes must not redirect these links into the current
workspace. This applies to both Markdown links and tool file entries. External
files remain readonly, and genuinely missing files still show a not-found error.
Remote preview authorization remains restricted to its existing allowed roots.

For a binary file without an inline viewer, the preview explains that it cannot
render the file in the shared rounded notice card, with full-width stacked actions
and Copy file path. On Electron with the session running on this machine, it offers
Open in default app and Reveal in Finder (or the host's file manager). Reveal
selects the file without launching its associated application. The preview and
More menu use the same system action and the same file identity, including local
absolute and parent-relative paths outside the workspace. The Files tree and the
side-panel More menu expose that identity as two copy rows — Copy relative path
always, and Copy absolute path only once the machine path is known. Remote
sessions never open a path on the
viewer's machine. Clicking the assistant link itself only opens the preview;
opening the OS application requires a separate user click.

Session PDFs open in a paged viewer at fit-width zoom. The toolbar supports direct
page entry, previous/next page, a toggleable thumbnail sidebar, quarter-turn
rotation that retains the current page, fit-page/fit-width/automatic and percentage
zoom choices, and an expandable text search with match navigation. These viewer
controls do not replace the side panel's existing file actions or modify the PDF.
Same-machine Electron reads local PDF resources through validated
64 KiB byte ranges rather than copying the complete file into the renderer; each
rendered page is limited to an 8-megapixel canvas. A PDF that cannot be read or
parsed falls back to the binary notice and its existing file actions. Other
providers continue to obey their existing binary preview limits.

DOCX, XLSX, and PPTX open in read-only session viewers. DOCX offers page zoom,
XLSX offers a virtual worksheet grid and sheet navigation, and PPTX offers slide
and thumbnail navigation. CSV and TSV open as a virtual table with cell search
and zoom; the existing Source tab remains available for text editing. These
previews do not add write or upload actions. The lightweight viewer entry is
available with the file panel, but an Office format engine and its worker load
only after that preview is active and the browser reaches an idle period. CSV/TSV
parsing and search run in a worker; inactive panels do not start it. Office
reads are bounded to 25 MiB before importing the format engine. Oversized or
unreadable Office files show the existing file-action notice. Provider
authorization and transfer limits still apply before viewer loading.

Right-clicking an assistant Markdown file link always offers Copy Path. On an
Electron renderer whose session belongs to this machine and whose workspace path
has resolved, its menu additionally offers Open File with the OS default app,
Open in the editor selected in the session header, Open with the other available
configured path launchers, and Reveal in Finder (or the host's file manager).
The path handed to the clipboard or OS excludes a Markdown line/column suffix; ordinary left
click retains that suffix for in-app preview navigation. Browser, mobile, remote,
and unresolved-local contexts offer Copy Path only.
Each rendered conversation surface resolves that capability from its own Session.
An opened, child, or side Session never inherits its opener's workspace, machine,
or native file actions.

Native mobile offers Share file in the binary notice and file menu. It exports
the complete authorized preview bytes into an isolated app-cache file and opens
the system share sheet, preserving the filename extension. Copy file path remains
available. Repeated exports are suppressed while one is pending; dismissal is not
an error, and cache cleanup is best-effort after handoff or failure. Existing
remote preview limits still apply (5 MiB binary); oversized or unavailable content
is not shared. This does not introduce a large-file transfer protocol.

Failures identify the action and give a next step for unresolved paths, missing
files, access denial, unavailable desktop IPC, or editor startup failures. A local
console diagnostic and Copy error details preserve the requested/resolved path,
session/machine identity, and returned system error. Copying is user-initiated;
these diagnostics are not automatically uploaded. VS Code file fallback URLs must
remain file URLs rather than acquire a directory-only trailing slash.

## Markdown file images

Live Markdown file previews render the complete available document without waiting
for referenced images. Image paths resolve relative to the opened document on its
owning machine, preserving absolute paths and decoding URL escapes once. Preview
authorization and transfer limits continue to apply to each image.

Same-machine Electron previews load images automatically through local file
resources. Remote previews, including mobile project browsing, reserve a compact
placeholder naming each image, with a per-image Load image action. No image file read or Blob URL
creation occurs before that action. Loading keeps the placeholder; failure offers
Retry without hiding the document. Successful remote reads become browser Blob
URLs. Leaving the preview releases those URLs and discards late responses; a new
document or provider must not inherit the previous image's load request.

This capability is supplied only by live file providers. Chat Markdown, standalone
uploaded Markdown without a filesystem provider, and anonymous publications do not
gain filesystem access. Ordinary web image URLs keep their existing behavior.

## Implementation evidence

- [Markdown renderer](../packages/components/src/components/ai-gui/markdown-renderer.tsx)
- [Binary preview](../packages/components/src/components/sessions/session-file-binary-preview.tsx)
- [PDF viewer](../packages/components/src/components/sessions/session-file-pdf-preview.tsx)
- [Office viewer entry](../packages/components/src/components/sessions/session-file-office-preview.tsx)
- [CSV/TSV viewer](../packages/components/src/components/sessions/session-file-csv-preview.tsx)
- [Shared file actions](../packages/components/src/hooks/use-session-file-actions.ts)
