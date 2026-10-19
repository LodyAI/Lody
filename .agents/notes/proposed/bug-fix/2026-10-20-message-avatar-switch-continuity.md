# Message avatar continuity across session switches

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1736

[中文](2026-10-20-message-avatar-switch-continuity.zh.md)

## Abstract

Message avatars can briefly show a fallback when returning to a conversation even
though the image bytes are cached. A bounded local correction now preloads the
cached blob used by a stable avatar and removes an effect-delayed source update.
The same isolated Chromium experiment changes from a fallback to an immediately
loaded image on the first blob return, with one avatar HTTP request on both runs.
Decoding runs asynchronously only for used avatars, so cache reads and first paint
do not wait and startup does not decode every stored avatar. Missing sender
metadata remains a separate, unresolved condition; this note remains proposed for
that investigation and does not attribute a deployed switch to one cause.

## Responsibilities and chosen scope

`lib/avatar-cache.ts` owns the renderer-wide URL-keyed memory map and persistent
`lody-avatar-image-v2` CacheStorage bucket. Reads after 24 hours serve the old image
and revalidate in the background; equal bytes retain the existing URL. Navigation
never clears this cache. These keys, TTL and byte-refresh behavior are unchanged.

`hooks/use-stable-avatar-src.ts` preserves the initial remote URL on a cold mount
while filling the cache. It now requests preloading of that local blob after fill,
or when a restored entry is used. The entry retains one off-DOM `Image`, loaded
with asynchronous decoding, for reuse across mounts. Replacing an already warmed
entry warms its successor. Startup restoration alone does not decode stored images.
No first paint or cache read awaits decoding, and preloading never fetches a remote
URL. There are no new timers, subscriptions, profile caches or retained session DOM.

The hook also tracks the input identity alongside its resolved source. New,
removed or newly available inputs derive their current value during render.
Source changes therefore do not commit the previous user's image or wait for an
effect to select an already available image. Background state updates retain the
existing source cleanup fence.

`UserAvatar` still delegates image readiness and broken-image fallback to
`@lody/ui` and Base UI 1.7.0. Its synchronous `complete`/`naturalWidth` path can
reuse a warmed image. A completely cold image, an unfinished preload or browser
memory-pressure eviction can still require the normal loading fallback.

The [sender identity decision](../../implemented/feature/2026-09-08-chat-sender-identity.md)
and [UI avatar migration](../../implemented/feature/2026-09-13-ui-avatar-kbd.md)
remain applicable. This correction changes neither identity nor avatar appearance.

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

## Remaining profile investigation

`ai-gui/index.tsx` first resolves the sender through `auth:getUserById`. Without
`user.image`, the image cache has no lookup key. The authenticated adapter shares
active queries, but its source registry and hook-local retained snapshots are not
a durable profile cache across all unmounts. `SessionChatInterface` also watches
the current user's profile for pending messages, so an existing same-user watch
can preserve it: a metadata miss must be observed, not assumed for each switch.

If a matching deployed recording confirms missing metadata, evaluate existing
account/workspace-scoped identity as an initial source, preserving authoritative
updates, deletion and account/workspace invalidation. Do not broaden this patch
into a generic stale-query cache or relax stale-access protections. Queries remain
unchanged in the local correction; genuinely absent metadata retains its fallback.

## Verification and limits

Five avatar-cache, seven avatar-source/component and five sender-identity tests
pass; component type-checking passes. New cases render the real `UserAvatar` with
explicitly signalled browser image loads and assert original first display,
warmed return, restored offline return, decoding failure and first-commit source
arrival/change/removal. A temporary ablation with unpatched source fails the warm
return and first-commit regressions; the patched sources are restored afterward.

Synthetic source, before/after browser results and ablation output are outside the
repository at `/private/tmp/lody-avatar-investigation-20261020/`. The existing
browser tab could not be connected for live validation. No deployed revision,
live metadata gap, Electron behavior, memory-pressure eviction or product timing
was measured. In an isolated checkout based on `7d6695cf3`, `pnpm check` and
`pnpm format` pass, including all 586 component test files (5,739 tests), CLI tests,
type-checking, lint and repository boundaries. Documentation checking retains six
existing broken links into absent ACP submodules and reports no new errors.
No dependency or Spec changed.
