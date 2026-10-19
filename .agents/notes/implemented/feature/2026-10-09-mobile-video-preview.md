# Shared mobile video file preview

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1363

[中文](2026-10-09-mobile-video-preview.zh.md)

## Abstract

Lody recognized WebM as a video in file cards but its mobile file viewer displayed
the unsupported-binary notice. Session viewers and the mobile project file browser
now use a shared native video element for browser-decodable video containers.
The player accepts existing authorized bytes or resource URLs, stops when hidden,
and preserves file actions after decoding failures. Remote videos remain subject
to the existing 5 MiB binary limit; no transcoding or large-file transport is added.

## Decision and responsibilities

- `SessionFileBinaryPreview` routes WebM, MP4/M4V, MOV and OGV to the static
  `SessionFileVideoPreview`. The mobile project browser uses that same player.
- `video-file-preview.ts` maps extensions to MIME types for generated blobs.
  A candidate extension is not a codec guarantee; actual media errors show the
  localized notice and the caller's existing file actions.
- Provider snapshots retain authorization and transfer ownership. The player never
  resolves a machine path, starts an agent, or fetches a new cloud endpoint.
- Native controls provide seeking and playback; `playsInline` keeps mobile
  playback inside the viewer. Playback never starts automatically. Deactivation
  unmounts the media element, clears its source and revokes owned object URLs.
  Backgrounding pauses playback without automatically resuming it.

```text
Authorized provider snapshot
  → session binary preview / mobile project file preview
  → shared video player
    → resource URL or typed blob URL
    → native playback controls / file-action notice
```

Adding only a file-type icon would not enable playback. Transcoding or raising the
remote transfer ceiling would change a separate transport contract, so neither is
part of this change. This extends the [local-file contract](../../../../specs/local-file-link-actions.md)
and preserves the action model described by the
[native sharing decision](2026-09-14-native-file-sharing.md).

## Verification

Lifecycle tests extend `session-file-binary-preview.test.tsx`; browser acceptance
uses the `WebmVideo` and `UnsupportedVideo` stories. The video fixture is a synthetic
160×90, two-second VP8 pattern, generated with FFmpeg's `testsrc2` source; it contains
no captured user content.

Passed: 51 tests across `session-file-binary-preview.test.tsx` and
`session-file-content-view.test.tsx`, components typecheck, targeted Oxfmt/Oxlint,
and `pnpm lint:i18n`. Two WebKit browser acceptance tests passed via
`pnpm --filter @lody/components exec playwright test tests/e2e/session-video-preview-acceptance.spec.ts --browser=webkit --workers=1`:
actual blob-backed VP8 playback at 390×844 and a real media-error fallback with
Share/Copy actions. The captured narrow screenshot was inspected; controls fit.
`pnpm run docs check` still reports six existing links into uninitialized Kimi/Pi
submodules, none in this change. `pnpm format` passed. `pnpm check` passed full
workspace typechecks and lint, then stopped in the unrelated CLI
`github-git-transport.test.ts` recursive SSH submodule fixture: the local Git
credential helper returned `context_unreadable` (3653 CLI tests passed, one failed).
The remaining root test run did not complete. Native-shell testing was not run.
Native iPhone/Android shell playback and shipped application versions are not
established by browser tests.
