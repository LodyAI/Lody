# Main services

Local session-history watch timeouts include the requested owner wait plus the
ordinary read allowance. Preserve the shorter deadline for ordinary control reads.

App icons are macOS packaged-app only. `app-icon-service.ts` owns device-local
preferences and the serialized native apply path; the renderer supplies only a
catalog identifier. Never edit signed resources or the shared development
Electron bundle. Finder custom metadata affects strict validation; see the
[icon decision](../../../../../.agents/notes/implemented/feature/2026-09-23-macos-app-icons.md).

Native notifications must stay strongly referenced after delivery succeeds, until
click, close, or failure. `NotificationService` owns those references and
`notification-delivery.ts` releases them; returning IPC success is not dismissal.
See the [lifetime fix](../../../../../.agents/notes/implemented/bug-fix/2026-09-20-notification-click-lifetime.md).

Window badge reports replace absolute contributions; always apply repeated values,
including zero. Discard a contribution when its renderer crashes or navigates to a
new document, as well as when the window closes. Renderer reconciliation must not
cause another bounce while permission waiting remains nonzero.

The Devbar Hub is off by default and starts only after the primary window's hidden
Developer Mode control enables it; `LODY_DEVBAR=true` is an automation override.
It binds to loopback, and the normal renderer CSP stays unchanged. Enabling it
always exposes the aggregate MCP endpoint and Terminals add-on, which grant local
shell/subprocess access; disabling Devbar removes both capabilities.
Do not add filesystem management, code-server, non-loopback binding, or remote
access without a new capability/security decision in the owning
[Spec](../../../../../specs/desktop-devbar.md) and
[Agent Note](../../../../../.agents/notes/implemented/feature/2026-09-16-devbar-hub-ui.md).

The disk-full guard (`storage-guard.ts`) blocks only after a Lody storage write failed
AND a volume holding Lody data is then found short of space; never block on space alone.
It leaves only by relaunch or quit, and never pauses background agents
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

Login-shell environment uses the application-owned native LoginShellCache Layer.
getUserShellEnvCachedLegacy is only a launcher boundary. After renderer unload
approval, quit awaits application disposal alongside CLI exit; retain failed process
owners for a later quit/recovery. Never substitute failure with null or bind a
replacement before release. See the
[decision](../../../../../.agents/notes/implemented/architecture/2026-10-10-effect-login-shell-probe.md).

## E2EE runtime

For E2EE changes, read [M1 boundaries](../../../../../.agents/notes/implemented/architecture/2026-10-21-e2ee-m1-runtime-boundaries.md)
and [M2 boundaries](../../../../../.agents/notes/proposed/architecture/2026-10-22-e2ee-m2-product-integration.md).
Account custody is lazy; native work settles before release. Use cached main-auth
identity, rechecking identity/generation after native open; never wait for network
under custody locks. Availability may use pinned renderer reads; evidence conflicts
never fall back. Persist originals before feed/pin. Verification/storage failure
closes its owner; malformed input does not close shared readers. Compare overlapping
verified originals, retain renderer checkpoints on takeover, and wait for missing history.

Cloud calls use fixed E2EE references and per-request auth/abort/deadlines;
disposal blocks late requests. Keep
network/key distribution outside custody locks. Caller journals retain exact bytes
for uncertain writes. Wire checks are structural; core owns signatures/authority.
SDK logs and raw causes cannot cross the adapter/IPC logging boundary.

Pairing journals its main-generated session and exact admission before HTTP.
Verify machine proofs locally; explicit consent precedes signing. Confirm from
verified originals, then await CLI current-key installation before content sync.
Reset only unsigned or verified settled records (exact commit/competing parent);
keep uncertain bytes. Re-prepare retries; new sessions require consent. Missing
credentials block preparation/approval; never export them via IPC. A socket deadline
bounds waiting, not completion: timeout is pending, never rejection or approval.
Keep original append/confirmation errors in main; verified readback wins over a
lost ack, and only stable cause-free errors cross renderer IPC.
