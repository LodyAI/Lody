# Markdown file images

Status: implemented
Translation: current

[中文](2026-09-27-markdown-file-images.zh.md)

## Abstract

Markdown file previews passed filesystem image paths directly to the browser, so
relative images could not resolve against their document. Live file surfaces now
provide the owning file reader and document path to the Markdown image renderer.
Same-machine resources load automatically; remote images remain skeletons until
clicked, then display the complete image through a Blob URL. Existing file policy
and transfer limits remain authoritative; uploads without a live provider are
outside this change.

## Decision and evidence

The UI reuses `FileWorkspaceProvider.openFile`: the session provider already routes
local images to Electron resources and remote images to bounded File Preview v3.
No new HTTP server, cloud upload, or daemon protocol is introduced. The alternative
of eagerly fetching remote images would delay reading and transfer files the user
may not need. The user-selected interaction instead makes each remote read explicit.

`resolveMarkdownImagePath` resolves relative paths in the existing file identity
module, without chat-link line-number stripping or worktree rerooting. Session
previews and mobile project browsing use the returned document spelling. The image
effect discards late reads and releases its own Blob URLs; Electron keeps ownership
of local capability URLs. Anonymous rendering is checked before the file resolver.

Intent: [local file links](../../../../specs/local-file-link-actions.md).
Implementation: [file image renderer](../../../../packages/components/src/components/ai-gui/markdown-file-image.tsx).

## Verification

Behavioral coverage extends the existing file-path and Markdown image suites for
relative/absolute paths, click-before-read, local resource URLs, failure/retry,
provider/document changes, URL disposal, and anonymous publication isolation.
All 80 tests across those suites and the session file-content suite passed.
The components type check, translation-key check, formatting and scoped lint also
completed (lint reports existing warnings in older files). Validation reused
local dependencies and isolated temporary dependencies; repository manifests and
lockfiles were unchanged. Documentation validation still reports missing links
into uninitialized ACP submodules, with no errors in the changed documents.
No interactive Electron or remote gateway validation has been performed.
