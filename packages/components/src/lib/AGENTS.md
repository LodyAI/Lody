# Shared UI helpers and file surfaces

Rules bind callers too. [Background](../../../../.agents/docs/components-package.md).

- Send/RPC await local commits, never Repo flush. Save `humanInputReceipts` before activation; RPC is redundant.
- Retry immutable Roost input; absent receipts stay unknown. Cache/refresh keeps
  all input. Resolve owner routing per call.

- Markdown caches hold bounded raw ASTs per grammar; clone per use; skip streams.

## Electron IPC types

- `electron-ipc-client.ts` may import `ElectronIpcServices` from main-process
  registration with `import type` only. Browser/mobile bundles must erase the edge;
  never add an Electron runtime/package dependency or allow Node APIs in shared UI.
- Keep `experimentalDecorators` and direct catalog-pinned `@types/node` for declarations.
  Service constructors own invoke signatures; never duplicate them in contracts,
  Specs or platform ports. Resolve erasure here or reconsider ownership.
  Push events/one-way sends stay in `@lody/shared/electron-ipc`.

## Crash recovery and diagnostics

- E2EE repair archives originals and uses account-bound native reads; keep conflicts.
  Readable evidence skips native work. Isolate bad intents.

- `ErrorBoundary`'s fallback shows the real error and one-click full-report copy on every
  build, details visible (`showErrorDetails` opts out); `error-boundary-report.ts` builds it.
- Error/not-found screens use `components/status-page.tsx`; pre-React `boot-failure.ts`
  copies its V2 tokens into plain DOM, never React/StyleX/Tailwind.
- Crash screens never reload/restart/reset themselves. `resetKeys` must not clear a captured
  error; the copyable fallback stays until the user presses a recovery button.
- A cloud query throws into render and keeps throwing: an optional surface owns an inline
  `ErrorBoundary`, so a backend failure degrades locally.
- `lib/clear-local-cache.ts` owns `restartIntoCacheClear` (recoverable `lody*` caches,
  still signed in; reloads one window) and `startHardReset` (full wipe/sign-out,
  host-native first, own confirmation). Defer deletes to next boot; clear synchronous
  storage BEFORE the flag. Record a clear's result; never re-run it unasked.
- Cache clearing uses a localStorage DELETE list, never a keep-allowlist. Include
  connection caches (Streams JWT/gateway, cursor-bypass, workspace-info) and new
  `lody:*` cache keys; retain auth tokens and preferences.
- Reports copy the `lib/session-render-trace.ts` tail; writers append one compact line,
  never drive behavior from it; surface mount/unmount uses a layout effect.
- Record crashes and unretried failures in `client-log.ts` (sent with bug reports):
  events and ids, never prompts, history or file content.
- `maybeClearLodyCacheOnBoot` runs once per page load; `RuntimeProvider` awaits it
  before opening repo IndexedDB.
- Route waits are `BlockingWaitPlaceholder` (recovery at 30s), never bare
  `LoadingPlaceholder`/`BootShell`; failures are `RouteMessage` with a `gate` (`null`:
  not a failure). `stuck-connection-banner.tsx` (`MainLayout`, 45s `loading`) opens
  the same recovery page. Nothing clears automatically: replicas may hold unsynced edits.

## File Preview and Code Collab

- Remote file surfaces read the owning session's file-index Flock. Local Electron
  initial trees and All Changes first use local `code-collab/get-file-index`
  Machine RPC without awaiting Flock, then subscribe to local Flock events.
  Delayed/failed subscriptions never block IPC or fall back to cloud. Stale join
  events converge with CLI asynchronous snapshot reconciliation. Machine RPC
  also provides exact content, save, LSP and diffs.
- `openFile` uses File Preview v3 plain reads: no workspace watch, All Changes recompute,
  or Flock publish. Electron verifies disk machine identity and reads via local IPC,
  independent of daemon/index readiness. Unknown targets never fall back to Streams;
  confirmed remote targets retain restricted, bounded `file/preview`.
- Small local text may enter the full-document editor/cache. `paged-text` is a separate
  readonly snapshot with bounded random reads; never seed the save cache, executable
  HTML, rendered Markdown/SVG, or full-document copy/download from it. Hidden paged
  viewers abort reads; virtual rows and one page bound memory independently of file size.
  Binary local previews carry resource URLs, never base64. Binary results, local or
  remote, never enter the text-open cache.
- The index is a hint, never an open gate: send unindexed paths to the machine, and
  leave `unavailableReason` unset for `binary` entries. Force `external: true` results
  readonly regardless of the index; saves stay inside the session workspace.
- Validate file-index rows with shared Zod helpers; preserve structured lazy-directory
  entries so `@file` completion initializes directories before refreshing results.
- Turn-scoped diffs come only from the CLI-local evidence store, never current disk,
  All Changes, or the removed v1 capture. File/diff reads retain cross-render in-flight
  limits; active requests release slots only on settlement.

- Preview and More-menu shell actions share `useSessionFileActions`. Only Electron
  on the session's own machine may invoke them; explicit local absolute artifact
  paths stay absolute, and remote paths never launch on the viewer's machine.
- Native file/PNG sharing uses complete authorized bytes, never host paths. Preserve
  transfer limits; stage isolated cache files and clean up after handoff, failure, or
  cancellation. Report cancellation separately; retain the preview and selection.

## File identity, caching, and errors

- `session-file-open-target.ts` owns normalization: canonical paths travel verbatim;
  Markdown hrefs decode URL/line suffixes and host roots; local Electron preserves
  other worktrees. Relative links negotiate `markdownFileLinks` candidates; multiple
  matches require a choice, unsupported daemons open as before. Pin the selected
  canonical path; no short-link cache. Anchors remain fields.
- Cache resolved opens under BOTH `response.path` (the save identity) and the requested
  path (viewer/change-check identity). After save, refresh EVERY `cacheKeys` alias.
  Preview reads are case-tolerant; `save-text` writes are case-exact.
- Before reason mapping in `session-file-error-state.tsx`, classify "outside the workspace"
  as a policy rejection, not filesystem "Access denied"; CLI keeps that exact phrase.
  Classify "owner session mismatch" as a startup race and advise "try again".
- Known gaps and their repair constraints: [path provenance and skipped entries](../../../../.agents/docs/components-file-paths.md#known-gaps).
  When repairing skipped entries, distinguish directory read failures and account for
  `openFile` retaining index `readonly`; an openable result must not become uneditable.

## Dropped files and folders

- `file-drop.ts` splits one OS drop into `files` and `directories` by
  `webkitGetAsEntry().isDirectory`; a folder is never an upload candidate.
  `dropped-local-path.ts` is the ONE path bridge (Electron
  `webUtils.getPathForFile`, absolute, forward-slash); web/mobile have no path,
  so a directory drop inserts nothing. A drop commits all paths together via
  `mentionActionsRef.insertPathMentions`, with one `dir` range per path. Preserve
  POSIX and Windows drive roots (`/`, `C:/`) during normalization and insertion.

## ACP dispatch

- Independent Plan toggles retain Roles; match other pins.

- Automatic Role cleanup needs a fresh matching runtime schema and owner access.
  Conditional writer transactions preserve concurrent edits and model/permission pins.
  [Contract](../../../../specs/agent-role-schema-reconciliation.md).

- Display every provider-supplied rate-limit window name with localized duration via
  `formatAgentRateLimitWindowLabel`, even when duration/utilization/reset match.
- Before creating top-level or child sessions, call `filterAcpSessionConfigOptionValues()`
  so cached values outside the current selector schema are neither dispatched nor persisted.

Attachment lifetime: [workspace ownership](../providers/AGENTS.md#attachment-transfer-ownership).
