# Static session sharing

Parent component instructions apply. `CLAUDE.md` is a symlink; edit this file only.

- This subsystem is undergoing a breaking static-publication cutover. Do not
  deploy until the anonymous reader, MCP confirmation, GC and integration fixtures
  have switched together. [Intent](../../../../../specs/session-sharing.md).
- `session-share-dialog.tsx` and controlled `session-share-manager.tsx` own
  authenticated publication. The manager is one screen at a time — setup,
  publishing, published, unfinished draft — with exactly one primary action each.
  A human action always starts publication, and the package is frozen in full
  before any byte is uploaded. Include all selected stored history, including
  thought/tool fields; disclose the sensitivity and public title on the first
  screen, never behind a disclosure. `onPrepare` freezes for review only and must
  never upload; `onPublish` freezes (or reuses the frozen retry keys) and then
  uploads and commits.
- Progress must stay honest: only the object upload has a byte total, so only it
  may show a percentage. Capture and the publish commit use the indeterminate
  sweep. Auto-copy on success may claim "copied" only after the clipboard write
  resolves; a rejected write shows the manual-copy field instead.
- A confirmation opened from an agent request freezes and shows the frozen copy
  as soon as the locked editor is usable, so the human reviews the exact bytes.
- `SessionShareDialogFrame` keeps its fixed header and one keyboard-aware scroll
  body; the manager's action row sticks to the bottom of that body. Opening must
  not autofocus a control — focus the panel, so the link field is not preselected
  and the sub-conversation checkbox is not armed. The portal must shrink/lift for
  the native keyboard. Closed editors must not load source documents or run cloud
  queries.
- The sub-conversation checkbox resolves to an explicit current set, capped at 32;
  future children never join automatically. A share that carries only some of the
  current children renders indeterminate with the exact count, never a plain tick. Client capture is not server
  materialization and source metadata is not a publisher identity certificate.
- `hooks/use-session-share-management.ts` owns prepare/confirm/upload/publish.
  Settings reuses `useSessionShareLinkActions` for copy/reset/revoke. Keep retry
  credentials and request identity stable; publish only after sealing.
- `session-share-request-cards.tsx` reads canonical pending requests, not history flags.
  Review locks the explicit target set; confirmation is app-only. Keep its editor
  mounted when begin consumes the request. Confirmed half-deployments remain visible
  and can be abandoned; a published request cannot use cancellation to revoke a share.
- `lib/session-share-publisher.ts` is app-only: hydrate all sources before
  synchronous capture, copy attachments under app authority, and release every
  source lease. It must never be imported by the anonymous entry. Workspace E2EE
  will decrypt here before plaintext publication, not on a server or reader.
- `lib/session-share-secrets.ts` owns device-local credentials scoped by
  user/workspace/share and credential version. Ordinary cache clear preserves them.
  Missing credentials require reset, never recovery from cloud data or Flock.
- The anonymous reader must use the static package client, pin one deployment,
  and never create a workspace runtime, Repo, Flock, machine connection, source
  attachment request or local durable history cache. Navigation is manifest-only.
  `session-share-reader.ts` reads a single immutable history; no polling, Loro
  document or source fallback. Main and side-pane selection are independent.
- Preserve app presentation: independent conversations in the left tree, child
  Tabs in the main pane and side-panel children at right. Reuse controlled
  presentation only, not workspace runtime hooks. The left tree uses the app's
  `session-row-leading-slot.tsx`, not a second connector/disclosure implementation.
- Markdown is dynamic and uses the existing conversation-copy builder, range
  selection, budget/truncation rules and result notices. No stored Markdown object.
- Share attachment reads resolve manifest IDs only. Never use source
  `storageSessionId`, a source expiry clock, public bucket URLs, or arbitrary
  resource links as read authority. Release object URLs and cancel disposed reads.
- Ordinary Markdown/ACP renderers also honor readonly context: no source task
  image hook, remote image URI or resource download fallback. Only inline bytes
  and manifest attachments are media authority. Hosts restrict image CSP as defense
  in depth. Credentials must never enter React keys; reset with a local epoch.
- Keep the read-only context free of composer, edit, retry, fork, permission,
  agent-control and workspace-navigation callbacks. Malformed reader errors
  unmount content and must not send history/error payloads to telemetry.
- Theme controls reuse the app ThemeProvider and key, not a share-specific setting.
  The host owns origin/build/CSP and an isolated anonymous platform/store.
