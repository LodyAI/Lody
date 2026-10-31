# Main services

History watch deadlines include owner wait plus ordinary read allowance;
ordinary control reads keep their shorter deadline.

App icons are packaged macOS only. `app-icon-service.ts` owns local preferences
and serialized native apply; renderers supply only catalog IDs. Never edit signed
resources or the shared development Electron bundle. Finder custom metadata affects strict validation; see the
[icon decision](../../../../../.agents/notes/implemented/feature/2026-09-23-macos-app-icons.md).

After delivery, retain native notifications until click/close/failure.
`NotificationService` owns references; `notification-delivery.ts` releases them.
IPC success is not dismissal.
See the [lifetime fix](../../../../../.agents/notes/implemented/bug-fix/2026-09-20-notification-click-lifetime.md).

Window badge reports replace absolute contributions; always apply repeated values,
including zero. Discard a contribution when its renderer crashes or navigates to a
new document, as well as when the window closes. Renderer reconciliation must not
cause another bounce while permission waiting remains nonzero.

Devbar defaults off; only the primary window's hidden Developer Mode control or
automation `LODY_DEVBAR=true` enables it. Keep loopback binding and renderer CSP.
Enabling exposes aggregate MCP and Terminals with local shell/subprocess access;
disabling removes both capabilities.
Do not add filesystem management, code-server, non-loopback binding, or remote
access without a new capability/security decision in the owning
[Spec](../../../../../specs/desktop-devbar.md) and
[Agent Note](../../../../../.agents/notes/implemented/feature/2026-09-16-devbar-hub-ui.md).

The disk-full guard (`storage-guard.ts`) requires a failed Lody write AND low space
on a Lody data volume. Space alone never blocks. Only relaunch/quit clears it;
background agents keep running
([decision](../../../../../.agents/notes/proposed/feature/2026-10-22-desktop-disk-full-guard.md)).

## Public browser

- The public browser (`services/public-browser-service.ts`) has NO network guard:
  no resolver check, no per-request hostname policy — only engine routing, so a
  loopback address is refused here and sent to Managed Preview. The view is a
  sandboxed `WebContentsView` with no preload, script injection, page capture,
  or agent-facing tool; the only reader of what it renders is the person looking
  at it, so it is strictly less capable than the user's own Chrome and a guard
  protects nothing. The one it used to have blocked every fake-IP proxy user.
  Engine routing is a check on the hostname TEXT: a public name that RESOLVES to
  loopback (`localtest.me`) still renders here, showing this machine's loopback
  rather than the agent's. Do not describe the split as resolution-accurate — it
  is a routing miss, not an exposure, and closing it means resolving every
  hostname again.
  Two triggers require bringing a guard back, and both are about who is on the
  other end, not about the address. A non-human READER — agent DOM access,
  screenshots, a preload bridge — makes rendered content exfiltratable. A
  non-human NAVIGATOR already exists: a Managed Preview page is agent-authored
  and can post navigation requests to the panel, so `session-browser-panel.tsx`
  refuses private-LAN destinations from page content. Keep that refusal on the
  panel side; this process cannot tell the two sources apart.
  The engine-routing check runs on `will-navigate` AND `will-redirect`, like
  `installNavigationGuard` in `window.ts`: `will-navigate` does not fire for a
  server-side 3xx, so a public page redirecting to loopback would otherwise
  commit here and never reach Managed Preview.

Renderer `beforeunload` vetoes on product windows (close, reload, quit) surface
through one native Stay/Leave confirmation (`../renderer-unload.ts`); Leave only
ignores that document's veto. Quit closes product windows, and so gets unload
approval, before it destroys relays or stops the CLI; Stay cancels quit with the
app fully running. A quit close whose renderer hangs or dies is destroyed so quit
cannot wait forever. Never destroy a normally closing window or add a path that
bypasses unrelated `beforeunload` guards such as unsaved editors.
A renderer-requested relaunch (`../relaunch-intent.ts`) calls `app.relaunch()` only at
`will-quit`; a quit the barrier cancels settles `cancelled`, and the IPC caller
withdraws any reset request it armed, so a later ordinary quit neither relaunches nor
resets. Relaunching quits the embedded CLI: never make it a default recovery step.

Quit bounds each renderer close and main-owned resource drain to fifteen seconds.
Unconfirmed work keeps its original owner until main exits, with a warning bounded
to five seconds and a nonzero exit. Never replace custody or clear pending writes
on a waiter deadline. CLI and shell process owners must still confirm release
before main can terminate. Quit diagnostics name phases, never credentials or causes.

## Auto-update

- Sparkle load failure falls back to electron-updater. Sparkle UI stays silent;
  progress and ready-to-install go through `ElectronUpdaterState` for the renderer
  banner. Packaging-side updater rules live in the [Electron guide](../../../AGENTS.md).
- Linux `.deb` installs go through `app-updater-linux-install.ts`, never
  electron-updater's `DebUpdater`: its `spawnSync` freezes the main process for
  the whole polkit prompt, which no JS-side timeout can interrupt. Spawn
  asynchronously, quit only after a zero exit, and treat a signalled installer
  as a failure rather than the success `spawnSync` reports. AppImage needs no
  privileged helper and stays on electron-updater.
- A downloaded package outlives a failed check or install. While
  `downloadedFile` is set, `recordError` keeps `phase: 'downloaded'`; dropping
  to `error` hides the sidebar banner and the About install button, which are
  the only ways to retry.

LoginShellCache Layer owns the shell environment; getUserShellEnvCachedLegacy
is launcher-only. After renderer unload approval, quit awaits application disposal
and CLI exit. Retain failed process owners for quit/recovery; never substitute null
or bind replacements before release. After a failed quit, retry owners once before rebuilding
the shell and relays and reopening a product window; unresolved owners use the localized
quit/retry dialog. See the
[decision](../../../../../.agents/notes/implemented/architecture/2026-10-10-effect-login-shell-probe.md).

## E2EE runtime

Read [M1](../../../../../.agents/notes/implemented/architecture/2026-10-21-e2ee-m1-runtime-boundaries.md),
[M2](../../../../../.agents/notes/proposed/architecture/2026-10-22-e2ee-m2-product-integration.md),
[join](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-personal-desktop-join.md)
and [machine](../../../../../.agents/notes/proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.md).
Fence opens/late D03 registration by identity/generation; pin D03 before signing.
Workspace custody; reset binds account/generation; recheck after lock/drain before archive.
No network under locks; drain before release.
Bad keys allow ledger open; core repairs.
Isolate verification/storage errors; malformed input keeps readers.
Originals precede feed/pin; compare overlaps, retain checkpoints, await history.
Conflicts refuse fallback. Failed close retains its fence; report restart-required.
Fixed cloud refs; auth/bound/abort; fence late disposed calls.
Keep uncertain bytes; raw/SDK causes never leave main.
Verified reads beat lost ACKs; cleanup retains admission.
`e2ee_staging_invalid` and `e2ee_staging_corrupt` are terminal.

Consent pins exact verified proofs/session/record/requestId/keys/credentials/pins.
Missing credentials block approval; never export them. Failed begin stays discoverable.
Archive terminal/foreign attempts, including pin-only+relay; fence same-request
unknown/admitting. Retain installed origins, other sessions and primary/cleanup causes.
Retirement needs exact superseded socket receipt and atomic all-null local match;
fresh sessions need consent. Unsigned staged material stays pending across windows/retries
until verified admission/history settlement (including later revocation); see [rationale](../../../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-local-pairing-recovery.md). Verify pinned endorsement/self-admission before snapshot binding/pin/cursor; allow sparse positions. Keys use verified mailbox/history; committed epochs may use staging. Staging read
denial/I/O failure cannot gate mailbox receipt. Show file protection; socket timeout stays pending. Await CLI current-key install.

Only rotate resumes candidates. Keep errors transport-free.

Machine sharing uses the lazy native host in `packages/e2ee-machine-sharing`.
Passive cache inspection uses existing entries only; never call openWorkspace or
readMachineSharing from that path. Counts are diagnostic, not execution authority.
Policy errors affect dependent execution only. Narrow read/update methods keep keys
and device credentials in main. See the [policy decision](../../../../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).
