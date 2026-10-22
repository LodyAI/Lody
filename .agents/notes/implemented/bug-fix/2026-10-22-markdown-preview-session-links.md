# Session links in Markdown file previews

Status: implemented
Translation: current

[中文](2026-10-22-markdown-preview-session-links.zh.md)

## Abstract

Markdown file previews rendered Session links as inert text because they lacked the context that enables chat links.
The file viewer now enables the existing Session link provider through an explicit switch that defaults to off.
SessionDetail derives that switch from the same navigation callback used by chat.
Both file-provider paths dispatch exact destinations through the existing deep-link mechanism.
Component tests cover navigation and disabled behavior. The isolated desktop rejected the synthetic file read, so desktop navigation remains unverified.

## Decision and scope

SessionFileContentView owns the provider around both Markdown rendering branches.
The alternative was to wrap the viewer in SessionDetail.
The explicit switch keeps standalone viewers disabled and permits behavioral tests at the real file-preview entry.
The provider continues to own exact-target dispatch, as required by the [deep-link decision](../architecture/2026-09-29-lody-deep-links.md).
The switch changes no stored state, so this correction requires no data repair.

MarkdownRenderer, URI parsing, Electron protocol policy, file-link callbacks, and heading anchors remain unchanged.
Relative file links retain path copying. HTTP(S) links retain external targets, and relative images retain document/provider resolution.

## Evidence and limits

`NODE_ENV=test pnpm --filter @lody/components exec vitest run tests/session-file-content-view.test.tsx` exercises the real viewer.
The new cases fail against the unchanged baseline because both Session chips remain spans.
They pass with the correction, including canonical workspace URIs, historical references, and removal of navigation capability after rendering.
The existing relative-image case also passes.
The former tests covered preview rendering and images but did not click Session links.
These tests observe deep-link events. They do not establish that a desktop router completed the destination switch.
The desktop build completed and reached the real right-panel viewer, but that viewer displayed Access denied for the synthetic local-project file.
