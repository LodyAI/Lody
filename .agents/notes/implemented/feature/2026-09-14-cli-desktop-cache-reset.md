# Reset the desktop app's local cache from the CLI

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/704

[中文](2026-09-14-cli-desktop-cache-reset.zh.md)

## Abstract

Both of the desktop app's local-state repairs — Settings → Clear cache and the
crash screen's full wipe — live inside the renderer, so a user whose renderer is
frozen cannot reach either, and a wedge caused by the local data the app reloads
survives every restart. `lody app reset-cache` arms the same two levels from a
terminal: the CLI writes a one-shot request into the installation's data directory
and the Electron main process consumes it before any window loads. The cache level
is still performed by the renderer, because only it can spare the Shortcut outbox
and the individual localStorage keys the clear must keep, which means that level
needs a renderer that boots; `--hard` is applied natively in main and is therefore
the level that still works when the renderer cannot run at all.

## Pressure

`packages/components/src/lib/clear-local-cache.ts` already implements both repair
levels well: a cache clear that keeps the session, preferences and offline Shortcut
drafts, and a hard reset that leaves nothing behind. What it cannot do is start
without the renderer. Both triggers are buttons, and the boot flag they set lives
in renderer localStorage, which no other process can write.

That gap matters because the realistic wedge is data-shaped rather than
transient — a poisoned document that hangs while the workspace runtime materializes
it, for example — so it reproduces on every launch. The app reopens the same local
stores, hangs in the same place, and the user has no way in.

## Decision

The CLI writes `desktop-local-reset.json` into `getLodyDataDir()`, the one path the
CLI and the desktop already derive identically per installation profile. Format,
atomic write, cancel, and the consuming read all live in one shared module
(`packages/shared/src/node/desktop-local-reset.ts`) so a writer and a reader cannot
drift on either the shape or the location. No login, no daemon, no deep link: a
deep link is attacker-reachable — any web page can navigate the OS to a registered
protocol — and a wipe must not be triggerable that way.

Main consumes the request in the `app.whenReady()` path, before `openMainWindow`,
and the read deletes the file before acting on it. That ordering is the point: an
unreadable, stale, or half-applied request must not be re-evaluated at every later
launch, which would be a boot loop that wipes local state forever.

The two levels split by who can do the work:

- `hard` runs natively here (`clearStorageData` + `clearCache` on the default
  session). It needs no renderer, which is what makes it the real escape hatch, and
  it removes the Better Auth token the renderer keeps in localStorage, so the app
  returns signed out.
- `cache` is handed to the booting renderer through a new one-shot
  `app.consumePendingLocalClear` IPC, and `runPendingClearOnBoot` treats it exactly
  like the in-app flag. Main cannot perform this level correctly: Chromium's
  storage APIs there are all-or-nothing per storage type, so a native version would
  also delete the prompt-shortcut outbox databases — which can hold the only copy
  of an offline save — and could not remove the specific localStorage cache keys
  (Streams JWT/gateway, workspace-info map, cursor-bypass markers) that a cache
  repair must clear.

One-shot, not sticky: the renderer boot path re-runs on every reload, so a mode
that stayed readable would re-clear the whole local replica on each reload. Main
therefore hands the mode out once. The renderer's probe is bounded (2s) because it
now runs on every desktop boot; a main process that never answers must delay the
first render, not prevent it.

A request that is never applied expires after a day, in either clock direction, so
a forgotten `--hard` cannot sign someone out later with nothing they can connect it
to, and a backwards clock correction cannot arm one forever.

## Alternatives considered

**Delete the Chromium storage directories from the CLI.** Works with no desktop
change, but only while the app is not running, and it cannot express the cache
level: leaving `Local Storage` intact keeps the stale connection caches, and
deleting it signs the user out. It also hard-codes Chromium's on-disk layout.

**Reach the running main process over the local CLI host lease.** Main already
serves that socket and is healthy exactly when the renderer is wedged, so the reset
could apply without a restart. Rejected for now: the lease's shutdown channel is
authenticated with a token the desktop does not publish, extending it touches
local-agent ownership rules, and the restart the user must perform anyway is the
cheaper contract.

**Inject the mode through preload `additionalArguments`.** Avoids an IPC on every
boot, but those arguments are fixed for the window's lifetime, so a reload would
replay the clear unless a consumed-nonce marker were added in localStorage. More
moving parts than a one-shot in main, for a saving of one IPC round trip.

## Validation

- `packages/shared`: 9 new cases over arm/consume/cancel — one-shot application,
  refusal retiring the file (invalid JSON, unknown version, unknown mode, array,
  missing field), expiry in both clock directions, the boundary that still applies,
  and cloud/local request-path disjointness.
- `packages/components`: 4 new cases — a CLI-armed `cache` clear runs the precise
  clear with no localStorage flag and keeps the auth token, the in-app flag wins
  without asking the desktop, "nothing armed" clears nothing, and an unanswered
  bridge gives up on fake timers instead of holding up boot. Ablating the new read
  fails the first case.
- `apps/cli`: `--hard`/`--cancel` resolution, including the refusal to accept both.
- Manual: built the dev CLI and ran arm, `--hard`, `--cancel`, the double-flag
  refusal (exit 1), and `--json` for each, checking the written request and that
  `lody app [path]` still parses. `--json` initially reached `app`'s own option
  instead of the subcommand; `appCommand.enablePositionalOptions()` fixes that and
  keeps every existing `lody app` spelling, including a trailing `--json`.

## Limits

Not exercised against a real packaged desktop launch: the native `hard` wipe and
the main→renderer handoff have unit and manual CLI coverage only, and neither is in
the E2E suite. The command also cannot report whether the desktop actually applied
the reset — the user learns that by reopening the app.

A reset still requires the user to quit the app themselves. If a future need
justifies applying one without a restart, the host-lease alternative above is the
path, and it would keep this file format unchanged.
