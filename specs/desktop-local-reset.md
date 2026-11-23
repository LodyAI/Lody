# Desktop local reset from outside the app

Status: draft
Translation: pending

Lody's desktop app repairs its own local state from Settings → Clear cache and,
one level further, from the crash screen's "Clear all data and sign out". Both
require a renderer that still answers clicks. This Spec covers the third entry
point, for when it does not: `lody app reset-cache`.

## Scenario

Someone opens the desktop app and the window never becomes usable — it paints and
then stops responding, or it comes back to the same broken state after every
restart, because the cause is in the local data the app reloads each time. There
is no button to press. From a terminal they run:

```bash
lody app reset-cache
```

They quit the desktop app, open it again, and land in a working app with their
account and settings intact.

## What the two levels mean

The levels are the same two the UI offers, so a person who has read either
description knows what a CLI-armed reset will do.

**Cache** (the default) removes only local state the app can rebuild: the local
conversation replica, stream cursors, cached repository/PR/mention/skill lookups,
image caches, and the cached connection state that can pin a client to a stale
gateway. The person stays signed in, keeps their preferences, and keeps unsent
Shortcut drafts, because those drafts can be the only copy of that work.

**Hard** (`--hard`) removes every local trace of the installation, including the
signed-in session, preferences, and cookies. The app comes back signed out. It is
the level to reach for when a cache reset was not enough, and it is the only level
that still works when the renderer cannot execute at all — the desktop applies it
itself, before loading any window.

`--cancel` withdraws a request that has not been applied yet, so a mistaken
`--hard` is recoverable.

## Guarantees

A reset is **armed, not performed**. The CLI records the request; the desktop
applies it the next time it starts. So the person must quit and reopen the app,
and nothing changes under a running one.

A reset is applied **at most once**. The request is retired before it is acted on,
including when it is refused as unreadable or stale, so no failure can turn into a
loop that wipes local state at every launch. A renderer reload does not repeat it.

A reset is applied **before the app reopens local storage**, which is why it can
remove state that a running app holds open.

A reset is **local and unauthenticated**. It needs no sign-in and no running
daemon — the app it recovers is usually the reason neither is reachable — and it
sends nothing anywhere. It reaches only the installation the CLI belongs to: a
public (local-platform) CLI cannot arm a reset for the cloud desktop, or the
reverse.

A request **expires** if it is never applied, so a forgotten `--hard` cannot sign
someone out days later with nothing they can connect it to. The bound is one day,
long enough to cover arming a reset and restarting the app later that day.

## Responsibilities

**The CLI** owns the request: which level, and withdrawing it. It never decides
what a level erases.

**The desktop main process** owns when a reset happens — before any window — and
performs the hard level itself, since that level exists for a renderer that cannot
run.

**The renderer** owns what the cache level erases, because only it can name the
individual databases and cache keys that must survive. The main process cannot;
Chromium's storage APIs there are all-or-nothing per storage type.

## Evidence

- [Request format and location](../packages/shared/src/node/desktop-local-reset.ts)
- [CLI command](../apps/cli/src/commands/app-reset-cache.ts)
- [Desktop application point](../apps/electron/src/main/services/local-reset-service.ts)
- [Renderer clear, shared with the in-app actions](../packages/components/src/lib/clear-local-cache.ts)
