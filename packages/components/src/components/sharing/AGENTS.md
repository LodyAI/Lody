# Session sharing

Parent component instructions apply. `CLAUDE.md` is a symlink; edit this file only.

- `session-share-dialog.tsx` and controlled `session-share-manager.tsx` implement
  authenticated management from the common session header menu. Only the open editor
  subscribes to metadata/cloud state; local platforms hide the entry via capability.
  Never import this management graph from the anonymous reader entry.
- Mobile hides that Header. `session-detail.tsx` mounts `session-share-mobile-menu.tsx`
  for its separate sheet; use the active persisted Tab, never the parent fallback for
  drafts/viewers. Key it by workspace/Tab so switching releases the open manager.
- `SessionShareDialogFrame` is shared by the manager stories and product dialog;
  its portal must shrink/lift for `--native-keyboard-height` and keep focused fields
  in its own scroll region. Root layout keyboard padding does not reach this portal.
  It is a fixed header over ONE scrolling body: the keyboard hook observes that body,
  and the manager's action row stays pinned to the body's bottom.
  Sub-conversations are ONE switch, not a checklist, and there is no separate consent
  checkbox: the disclosure on the link card is the notice. The preview notice states that the root title is public
  without the access fragment; it must not imply public body/attachment access.
  The switch resolves to an explicit id set of the descendants that are eligible RIGHT NOW, capped at
  `SESSION_SHARE_MAX_TARGETS`; never let it imply that later ones join by themselves,
  and never let it pull in an ineligible target. State each meaning once, next to what
  it describes. Explain a blocked action rather than only disabling it — an unshareable
  root says why — and render Save only when something actually changed.
  The dialog currently shows ONLY this conversation's own link. Other grants that also
  cover it are deliberately not listed, so revoking here does not necessarily stop all
  outside access; keep `state.sources` intact for `copyableShareIds` and do not present
  revocation as a full stop.
- `hooks/use-session-share-management.ts` uses public cloud descriptors and server
  verified eligibility. Relationships only discover candidates; the stored grant stays
  an explicit id list the server verifies target by target, whatever the UI shows.
  Preserve the draft's expected versions across concurrent edits. Expire displayed
  access on the lease clock even without a reactive query update.
- `lib/session-share-secrets.ts` owns device-local secrets scoped to user/workspace/link
  and credential version, not scope version. Persist only successful create/reset results;
  a missing secret requires reset. These are credentials, not recoverable cache entries;
  ordinary cache clear preserves them, hard reset removes them. Never log credentials.

- `session-share-page.tsx` exports the controlled surface and hosted reader state.
  It must not import the app router or create a workspace runtime, Repo, Flock,
  read receipt, dispatch, or membership subscription. Navigation comes only from
  the authorized manifest; a stream's references do not authorize other streams.
  Read-only is expressed by offering no write affordance, not by a standing banner;
  the header's status region announces interruptions only. Its appearance control
  reuses `theme-provider`'s cycle, `system` default and storage key — never a
  reader-specific mode or key, which would compete with the app's cached choice.
- `lib/session-share-navigation.ts` derives the target from `?tab` and the current
  manifest. Browser history preserves the access fragment; unsupported targets fall
  back to the root and never issue their own read. Tag snapshots with their target so
  switching cannot render the previous history under a new title. The shared stream
  view's existing memory LRU owns per-session scroll positions.
- `session-share-error-boundary.tsx` unmounts a malformed reader (closing streams and
  attachments) and offers only an explicit reload. Unlike the authenticated app's
  diagnostic boundary it retains/reports no error payload and imports no telemetry.
  The hosted root suppresses React's default caught-error logger for the same reason.
- `lib/session-share-reader.ts` owns one in-memory LoroDoc and Streams transport.
  Keep both its read-only adapter and network method/path gate. Include the shared
  snapshot codec so existing Zstd and raw snapshots remain readable. No persistence.
  Its schema-free Mirror is read-only: never provide initialState, schema defaults,
  setState or an ephemeral store. It preserves unchanged message identity across
  stream updates. `createSharedChatStreamBuilder` owns the surface's ConversationView
  adapter and render cache; filter invalid items only in its read projection and
  reuse unchanged entries across snapshots. Dispose on unmount and reset on target
  changes; never pass a history array directly to the windowed renderer or
  use the authenticated app's global history cache for anonymous content.
- `share-attachments.tsx` uses the share bearer API and existing file/image UI.
  Never fall back to workspace auth, public R2 URLs, or an unchecked storage session
  ID. Revoke object URLs and abort reads when the target or grant becomes unavailable.
  Preserve inherited `storageSessionId` as a selector on the authorized target's API;
  the server verifies the original stream reference before using it. Never navigate
  to that storage session or silently substitute the target namespace. Local attachments
  show unavailable, not a promise of background uploading. Text previews provide
  a source download action and render only as text.
- `../ai-gui/session-readonly-context.tsx` provides attachment rendering and disables
  permission actions. The hosted entry supplies no composer, editing, retry, fork,
  navigation-to-workspace, or machine-control callbacks to the shared stream renderer.
- The private Web host owns domain/build/CSP configuration and an isolated anonymous
  platform/store. It must not mount auth/telemetry providers. Public UI stays here.
- Stories: `src/stories/SessionSharePage.stories.tsx`. Protocol tests:
  `tests/session-share-reader.test.ts`; built-page tests live in the private Web host.
