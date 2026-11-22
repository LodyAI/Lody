# Message avatar continuity across session switches

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1736

[中文](2026-10-20-message-avatar-switch-continuity.zh.md)

## Abstract

Message avatars and multi-member sender names could briefly fall back or disappear when returning to a conversation, scrolling virtualized rows, or handing a pending send over to hydrated history. `use-stable-avatar-src.ts` preloads the cached blob used by a stable avatar and derives source updates during render, while `useWorkspaceSenderProfile` and `lib/workspace-sender-identity.ts` retain account/workspace-scoped member directory and sender-profile metadata across unmounts and reloads. In the isolated Chromium experiment, the first blob return changes from a fallback to an immediately loaded image with one avatar HTTP request on both runs. Decoding runs asynchronously only for used avatars so cache reads and first paint do not wait, and genuinely absent metadata still retains its fallback.

## Responsibilities and chosen scope

`lib/avatar-cache.ts` owns the renderer-wide URL-keyed memory map, bounded
IndexedDB `lody:avatar-image-cache` store (with `lody-avatar-image-v2`
CacheStorage fallback/migration so `file://` Electron and `capacitor://`
origins persist reliably), and a synchronous `lody:avatar-cache-index` key set.
Reads after 24 hours serve the old image and revalidate in the background; equal
bytes retain the existing URL. Navigation never clears this cache; recoverable
cache clearing removes both stores and the index.

`hooks/use-stable-avatar-src.ts` suppresses remote `<img>` fetches on new pages
when `hasPersistedAvatar` confirms local bytes exist, switching directly to the
persisted blob before startup rehydration finishes, while preserving the initial
remote URL on a genuinely cold first visit. It preloads the local blob after fill
or when a restored entry is used, and `useWorkspaceMembers` warms active member
avatars. The entry retains one off-DOM `Image`, loaded
with asynchronous decoding, for reuse across mounts. Replacing an already warmed
entry warms its successor. Startup restoration alone does not decode stored images.
No first paint or cache read awaits decoding, and preloading never fetches a remote
URL.

The hook also tracks the input identity alongside its resolved source. New,
removed or newly available inputs derive their current value during render.
Source changes therefore do not commit the previous user's image or wait for an
effect to select an already available image. Background state updates retain the
existing source cleanup fence.

`UserAvatar` still delegates image readiness and broken-image fallback to
`@lody/ui` and Base UI 1.7.0. Its synchronous `complete`/`naturalWidth` path can
reuse a warmed image. A completely cold image, an unfinished preload or browser
memory-pressure eviction can still require the normal loading fallback.

The [sender identity decision](../feature/2026-09-08-chat-sender-identity.md)
and [UI avatar migration](../feature/2026-09-13-ui-avatar-kbd.md)
remain applicable.

## Synthetic browser evidence

Checkout `4cc74cae8` with existing unrelated working-tree changes, Node 24.14.0,
and headless Chromium 145.0.7632.6. A temporary Vite page imports the production
`UserAvatar`, stable-source hook, cache and UI primitive. A local synthetic SVG
is the only avatar; no product data or external image server is involved.

| State                                                                                                                 | Before: immediate / next frame | After: immediate / next frame |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------- |
| Original URL loaded; blob bytes cached; leave for an avatar-free surface and return using the blob for the first time | Fallback / fallback            | Loaded / loaded               |
| Return again with the same decoded blob and available metadata                                                        | Loaded / loaded                | Loaded / loaded               |
| Return with metadata absent, while the blob remains hot and decoded                                                   | Fallback / fallback            | Fallback / fallback           |
| Supply metadata to that mounted avatar                                                                                | Fallback / loaded              | Loaded / loaded               |

Each run serves one avatar HTTP request. The original URL is loaded before the
first return, and both returns reuse the same blob URL within that run. Samples
observe DOM availability before paint, not pixel presentation or a guaranteed
number of delayed frames. A hot decoded return is already immediate before the
correction; not every Base UI remount flashes.

## Lifecycle and Effect assessment

The stable-source hook triggers preloading; the shared cache entry owns its image
and decode. Component cleanup fences local updates without aborting an image
another avatar may use. Existing entry replacement, delayed object-URL revocation
and memory clearing own release. Decode rejection is caught and preserves the
existing fallback. One image object is retained per used cached avatar; the browser
still controls decoded-pixel retention. No new wait is added before UI handoff.

Effect feature/fix assessment: this is a browser adapter and React source-derivation
correction within an existing Promise cache. A complete native unit would also
change fetch, revalidation, persistence and application ownership. That exceeds
this small behavior fix, so migration is deferred without a runtime/dependency or
ledger change.

## Sender metadata continuity

`ai-gui/index.tsx` and `SessionChatInterface` resolve human senders through
`useWorkspaceSenderProfile` (`hooks/use-workspace-sender-profile.ts`), backed by
`lib/workspace-sender-identity.ts`. Without `user.image` or `user.name`, the image
cache has no lookup key and multi-member user rows lose their sender label while
per-row `auth:getUserById` subscriptions reconnect across virtualized unmounts or
session switches.

`useWorkspaceSenderProfile` prefers live `auth:getUserById` results (including
explicit `null` to clear deleted accounts), then falls back to retained sender
profiles, the same-scope `useWorkspaceMembers` directory, and the matching
authenticated `userAtom` identity. Retention is keyed by CloudApi owner, account
ID and workspace ID (persisted for the production cloud adapter and registered in
`clear-local-cache.ts`), so account, workspace or adapter changes discard retained
labels without relaxing stale-access protections on authorization queries.

## Verification and limits

`tests/avatar-cache.test.ts`, `tests/use-stable-avatar-src.test.tsx`,
`tests/user-message-sender-identity.test.tsx`, and
`tests/session-pending-message-row.test.tsx` cover original first display, warmed
and restored offline return, decoding failure, first-commit source arrival/removal,
directory-seeded sender names before `auth:getUserById` resolves, virtualized
remount and reload retention, explicit `null` deletion, cross-account/workspace
isolation, and pending-to-history handoff continuity. Browser memory-pressure
eviction and device frame-time distributions remain unmeasured.
