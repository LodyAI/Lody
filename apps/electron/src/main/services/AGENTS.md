# Main services

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

Login-shell environment uses the shared native probe through the explicit
`getUserShellEnvCachedLegacy` cache. Preserve failures and recovery owners rather
than returning null for failed cleanup. Before changing it, read the
[decision](../../../../../.agents/notes/implemented/architecture/2026-10-10-effect-login-shell-probe.md).
