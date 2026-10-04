# Electron main process

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Parent [module rules](../AGENTS.md) apply.

## Diagnostics

Main-process `console` output, lifecycle, and embedded-CLI supervision reach the
CLI daily log through `desktop-log.ts`; write synchronously, never persist
credentials (redaction is only a backstop), and trace CLI spawns without their
arguments. See the [tracing decision](../../../../.agents/notes/implemented/feature/2026-09-25-daily-log-crash-and-stall-tracing.md).

## Prepared windows

macOS local target preparation shares the opt-in spare's single slot. Bind readiness
to sender, target and generation; cancellation belongs to its source request.
Expire unclaimed views and destroy them on source close. Claim adopts identity and
reload target without remounting; activate renderer effects only after native show.
Retarget only within the same workspace, reuse the single hidden renderer, and
revoke readiness with a fresh generation before navigation; stale replies cannot show it.
The [window Spec](../../../../specs/desktop-windows.md) owns the behavior contract.

## Startup theme

- A product window opens on the COMMITTED theme, not the OS appearance: `theme-settings.ts`
  feeds `getInitialMainWindowThemeSource` before the `BrowserWindow` exists (native frame
  and win32 overlay; the `.dark` class is the CSP-hashed boot script's job). A preview
  never reaches that store. Every `conf` store built at import or startup goes through
  `createSettingsStoreWithFallback` (`createMainSettingsStore` for new `userData` stores):
  `conf` validates in its constructor, so a malformed file would otherwise stop launch.
