# Local file links and system actions

Status: draft
Translation: pending

When an assistant links to a local source file or build artifact, the user can
open it in the session's right-side preview. The inline link uses blue text and
a matching file-type icon, without a pill background or border. Hover and keyboard
focus remain visible, and line references retain their existing navigation behavior.

For a binary file without an inline viewer, the preview explains that it cannot
render the file in the shared rounded notice card, with full-width stacked actions
and Copy file path. On Electron with the session running on this machine, it offers
Open in default app and Reveal in Finder (or the host's file manager). Reveal
selects the file without launching its associated application. The preview and
More menu use the same system action and the same file identity, including local
absolute and parent-relative paths outside the workspace. Remote sessions never open a path on the
viewer's machine. Clicking the assistant link itself only opens the preview;
opening the OS application requires a separate user click.

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
