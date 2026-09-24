# Local file links and system actions

Status: draft
Translation: current

[中文](local-file-link-actions.zh.md)

When an assistant links to a local source file or build artifact, the user can
open it in the session's right-side preview. The inline link uses blue text and
a matching file-type icon, without a pill background or border. Hover and keyboard
focus remain visible, and line references retain their existing navigation behavior.

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

## Implementation evidence

- [Markdown renderer](../packages/components/src/components/ai-gui/markdown-renderer.tsx)
- [Binary preview](../packages/components/src/components/sessions/session-file-binary-preview.tsx)
- [Shared file actions](../packages/components/src/hooks/use-session-file-actions.ts)
