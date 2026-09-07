# `@lody/components`: why the shared-UI rules read the way they do

Scope: `packages/components`. The binding rules live in
[that package's AGENTS.md](../../packages/components/AGENTS.md) and its child scopes;
this page keeps the reasoning that would otherwise crowd them out.

## Crash surfaces

A crash the user cannot read or copy is a crash we never hear about, which is why the
`ErrorBoundary` fallback shows the real error text and offers a one-click copy of the
full report on every build rather than only in development.

Automatic recovery is deliberately bounded. A crash screen that reloads or resets by
itself can loop forever on a deterministic error, so `resetKeys` recovery stops after
`MAX_AUTOMATIC_RESETS` for a repeating error and hands control back to the user.

Both cache-recovery levels defer their asynchronous deletes to the next boot because
`deleteDatabase()` blocks while the runtime still holds a connection; synchronous
storage is cleared first so the boot flag is never written over a half-cleared state.
The localStorage sweep is an explicit DELETE list rather than a keep-allowlist so that
the failure mode of forgetting a key is a surviving cache entry, not a wiped user
preference.

The report carries the tail of `lib/session-render-trace.ts` because a React #185
(nested update limit) report names the fiber where the limit tripped, not the loop that
drove it. The trace is diagnostics only, and its surface mount/unmount lines are written
from a layout effect because passive effects may never flush inside a crashing cascade.

`maybeClearLodyCacheOnBoot` is shared by `AppInitializer` and `RuntimeProvider` so a
user wedged before any workspace still gets the wipe, and so the repo IndexedDB is never
opened before the pending clear has run.

`stuck-connection-banner.tsx` is observational because a slow first sync is not a
failure: the banner offers the cache-clear flow after 45s of continuous `loading` while
the connection attempt completes exactly as it would without it.

## File preview versus Code Collab

Opening a file to look at it is not a collaboration session. File Preview v3 answers with
a plain read — no workspace watch, no All Changes recompute, no Flock publish — which is
why the file index is only a hint there: a path the index has never seen (an
agent-produced temporary file, say) is still worth sending to the machine, and "too large
to preview" is mostly a remote verdict rather than a fact about a file on this machine,
since the local IPC path reads to `FILE_PREVIEW_V3_LOCAL_LIMITS` derived from the 16 MiB
local response cap.

Preview reads a wider path set than `save-text` writes, which stay inside the session
workspace. Without forcing `external: true` results readonly the editor would show a Save
button for a file the machine will refuse, and the user would lose the edit at save time.

## Theming and fields

`--input` is the theme's raw `input.background` and doubles as a muted chip/composer
slab, so in a light theme it can sit below the page color and read as a disabled field.
`--input-field` is derived in `lib/vscode-theme/vscode-theme-css.ts` as the lighter of
the field and page colors, which keeps a dark theme's raised fill and lifts a light
theme's field onto the page. Keeping gray exclusively for `disabled:bg-muted` is what
makes disabled state legible at all.

## Emoji picker dataset

`frimousse` fetches its dataset from a public CDN by default, which leaves the picker
spinning forever in an offline desktop or mobile app. The bundled dataset is a URL
contract rather than an import: the library builds `${emojibaseUrl}/${locale}/…` paths at
runtime, so a hashed `?url` asset cannot satisfy it and a host that forgets the Vite
plugin ships an empty picker. Anchoring on `document.baseURI` fails for the same class of
reason — the router uses browser history, so a deep route resolves the dataset path
against the route and the dev server answers with the SPA fallback HTML.

## Codex reset forecast

`SessionUsagePopover` is mounted per open tab and side chat, hidden ones included, and
`ProviderRow` per provider, so a mount-time fetch of the third-party forecast was a
request storm. Loading only when a user opens a surface, coalescing concurrent callers
onto one in-flight request, and clamping the served `Cache-Control: max-age` to 1m–5m
(the endpoint's CDN-shaped 4h is wrong for someone who just opened the panel) keep it to
roughly one 304 per interaction. An always-visible composer band was rejected because it
would have to load in the background to know whether to render at all.
