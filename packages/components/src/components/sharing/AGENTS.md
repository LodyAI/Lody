# Static session sharing

Parent rules apply. `CLAUDE.md` is a symlink; edit this file only.

- Breaking static-publication cutover in progress: do not deploy until the
  anonymous reader, MCP confirmation, GC and integration fixtures switch
  together. [Intent](../../../../../specs/session-sharing.md).
- `session-share-dialog.tsx` and controlled `session-share-manager.tsx` own
  authenticated publication. The manager is one screen at a time — setup,
  publishing, published — with exactly one primary action each.
  A human action starts publication; the package is frozen in full before any
  byte is uploaded. Include all selected stored history, including
  thought/tool content with the [sharing projection](../../../../../specs/session-sharing.md).
  The first screen states that anyone with the link can view it, and that images
  are shared while file attachments are not. `onPublish` freezes (or
  reuses the frozen retry keys), uploads and commits. There is no publication
  preview or prepare-only action. A stale draft is revoked by the next publish,
  never on dialog open.
- Progress must stay honest: only the object upload has a byte total, so only it
  may show a percentage; capture and the publish commit use the indeterminate
  sweep. Auto-copy may claim "copied" only after the clipboard write resolves; a
  rejected write shows the manual-copy field.
- MCP consent names purpose, exact targets and full URL delivery to the agent.
  One approval starts an independent share and encrypted result delivery.
  Hide cards on local or canonical publication success.
- `SessionShareDialogFrame` keeps its fixed header and one keyboard-aware scroll
  body; the manager's action row sticks to the bottom of that body. Opening
  focuses the panel and never a control, so the link field is not preselected and
  the sub-conversation checkbox is not armed. The portal must shrink/lift for the
  native keyboard. Closed editors must not load source documents or run cloud
  queries.
- The sub-conversation checkbox resolves to an explicit current set, capped at 32;
  future children never join it. A share that carries only some of the
  current children renders indeterminate with the exact count, never a plain
  tick. Client capture is not server materialization, and source metadata is not
  a publisher identity certificate.
- `hooks/use-session-share-management.ts` owns prepare/confirm/upload/publish.
  Settings reuses `useSessionShareLinkActions` for copy/reset/revoke. Keep retry
  credentials and request identity stable; publish only after sealing.
- `session-share-request-cards.tsx`: canonical requests outside virtual rows;
  app-only approval; scrolling/confirmation must not unmount publishing.
  Abandon unfinished deployments; cancellation cannot revoke published shares.
  Known capability fragments are omitted from exports, never live history.
- `lib/session-share-publisher.ts` is app-only: hydrate all sources before
  synchronous capture, copy attachments under app authority, and release every
  source lease. Never import it from the anonymous entry. Workspace E2EE will
  decrypt here before plaintext publication, not on a server or reader.
- `lib/session-share-secrets.ts` owns device-local credentials scoped by
  user/workspace/share and credential version. Ordinary cache clear preserves them.
  Missing credentials require reset, never recovery from cloud data or Flock.
  New publication must durably save and read back the begin response's reader
  credential before upload or commit. Storage failure stops publication;
  closing a dialog during the final commit cannot discard its only reader secret.
  Upload secrets remain editor-local. Reset-link behavior is separate.
- The anonymous reader must use the static package client, pin one deployment,
  and never create a workspace runtime, Repo, Flock, machine connection, source
  attachment request or durable history cache. Navigation is manifest-only.
  `session-share-reader.ts` reads a single immutable history; no polling, Loro
  document or source fallback. One conversation is selected at a time. A `ready`
  read is cached in memory per `StaticShare`; attachments and reloads re-read.
  Capture removes `system_notice/task_proposal` from display containers before
  attachment I/O; reader validation rejects it. Preserve `subagent_task` and
  opaque tool/text content. This is not keyword-based task redaction.
- Preserve app presentation: independent conversations in the left tree and
  child Tabs in the one main pane. The reader has NO right pane and no toggle
  for one, so a side-panel child renders as an ordinary Tab: published content
  must stay reachable, never dropped with the pane. Reuse controlled
  presentation only, not workspace runtime hooks. The left tree uses the app's
  `session-row-leading-slot.tsx` in that slot's row box, not a second
  connector/disclosure implementation. It marks the open pane's root by tinting
  `foreground` (never `bg-accent`) on the title box alone, never across the
  connector gutter.
- Markdown is dynamic: the existing conversation-copy builder, range selection,
  budget/truncation rules and result notices. No stored Markdown object.
- The shared file-attachment rollout switch defaults off: capture replaces typed
  files with localized text, without reading them; images remain enabled.
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
- Copy Agent Prompt is an explicit short-lived capability export, not a fork.
  Localize it in the reader's language and keep token URLs out of telemetry. Pass
  the selected conversation and pinned deployment; issue access only for published
  deployments.
  Clipboard rejection must leave a manual-copy prompt, not claim success.
- Reader chrome: the header starts with the packaged Lody icon (its black tile
  never changes with appearance), linking to the product in a new tab. From right
  to left: viewer identity, language toggle, theme control. English/Chinese uses
  `lody-language`, without app/OneSignal hooks. The tree is a left sidebar on wide
  viewports and a left drawer on narrow ones; CSS selects each layout's toggle,
  never a viewport hook. Its toggle animates width, rows mounted and `inert`
  while closed; a `separator` handle resizes it within bounds that keep the
  transcript readable, dropping that animation only while dragging. Theme offers
  Light/Dark only, coerces other stored values to Light, and drives the reader
  ThemeProvider independently of app appearance.
  Publication does not embed the reader.
- `ShareViewer` is host-supplied and defaults to `signed-out`. The reader never
  authenticates and, on its own origin, cannot read the app's session cookie:
  showing a name or avatar requires the host to establish it. Signed-out renders
  no identity placeholder or login entry, on either wide or narrow viewports.
- Name panes with the app's `shared/tab-pill-strip.tsx`, never a second title bar,
  for solo conversations and child Tabs. `session-share-actions.tsx` is the
  foot: one row with Markdown copy, Copy Agent Prompt and its disclosure. Never
  imitate the composer; a visitor cannot write.
- The host owns origin/build/CSP and an isolated anonymous platform/store.
- Static share snapshots render through `createSharedChatStreamBuilder`, which owns
  the page-local ConversationView adapter and cache. Dispose it on unmount; never
  pass history arrays directly to the windowed renderer.
