# Unify the window lifecycle of in-app shortcuts

Status: implemented
Translation: current

[中文](2026-09-10-shortcut-window-lifecycle.zh.md)

## Abstract

In-app shortcuts already had a unified registry, but DOM matching, listener lifecycle, command
decisions and persistence refresh were mixed into one class; one cloud success path of the
authenticated workspace also never mounted the command implementations, and multi-window did not
refresh user bindings cached in other renderers. Each renderer now attaches shortcuts through a
single React host: `@tanstack/hotkeys` owns parsing, normalization, matching and display, the
registry owns only Lody's command semantics, and the persistence module owns cross-window refresh.
The authenticated success layouts share the same command host. Shortcut configuration remains
device-level local state and a command runs only in the window that received the key press;
OS-level global shortcuts continue to be managed independently by the Electron main process.

## Decision and boundaries

`AppInitializer` is the only mount point of `CommandShortcutHost` per renderer. From a registry
snapshot the host builds multi-binding handlers with TanStack Hotkeys and then installs one
capture-phase `keydown` listener; React's cleanup unmounts it symmetrically, and the mapping is
replaced whenever a command is registered or unregistered or a user rebinds. The library's built-in
manager is not used directly, because it installs only a bubble-phase listener and therefore cannot
guarantee that application-level commands still arrive after a local component such as a Radix focus
trap stops propagation. Lody still owns the domain rules: the command id stack, most-recently-mounted
precedence, `when`, `KeyScope`, yielding to text inputs, user overrides, palette/settings and
analytics.

Bindings use the library's native single-chord syntax, with the platform primary modifier written as
`Mod`; the runtime no longer maintains a second parser and no longer compiles Lody bindings into
third-party regular expressions. TanStack Hotkeys supplies the same canonical normalization to the
registry's conflict index and to the DOM matcher, and handles macOS Option glyphs and shifted
punctuation through an `event.code` fallback. The recording entry point uses the library's
event/normalization API and restores letters, digits and the library's defined punctuation codes to
physical keys only at the DOM boundary, so a recorded result and the matcher's fallback yield the same
canonical binding. `$mod` in legacy localStorage and Electron global-shortcut configuration is
migrated to `Mod` at the read boundary; new defaults and new writes only produce `Mod`.

TanStack Hotkeys 0.8.0 is still alpha, so the dependency is pinned exactly and semver auto-upgrades
are not allowed. It was adopted to hand parsing, platform normalization, matching, validation and
display to one library; an upgrade must first rerun the command-domain, rebinding and global-shortcut
contract tests and confirm that the capture host is still necessary. `react-hotkeys-hook` was not
adopted because it offers no canonical/format API shareable by the registry, the settings page and
Electron; tinykeys was not retained because keeping the existing physical-key behavior would have
required a custom syntax compiler on top of it.

`user-bindings.ts` owns the `storage` subscription on its own. The host re-reads user bindings on
mount, a write from this window's settings page updates the registry directly, and other windows
rebuild their mapping from validated localStorage on the event. No extra IPC or broadcast protocol is
introduced, because the browser's native events within one Electron session already cover the required
notification.

The authenticated workspace's local, local-token and ordinary cloud success paths share
`AuthenticatedWorkspaceContent`. That host is responsible only for long-lived workspace commands and
helper components; configurable route-level commands continue to register through `useCommand` as
their own components mount and unmount. System-level shortcuts, the window-close menu, and local
interactions such as overlay Escape, focus navigation and editor keys are not moved into the renderer
registry.

This fix is the infrastructure part of Issue #288; it adds no workspace-switching command and no
swipe gesture. Application-level shortcuts have exactly one registration entry, `useCommand`/registry;
component-local keys such as overlay Escape, list navigation, editor keys and first-interaction unlock
stay with their owners. Later workspace commands reuse `useCommand` rather than creating a new global
listener.

## Verification

Command-domain tests cover registry decisions, real DOM capture, TanStack normalization and matching,
physical-key recording, dynamic rebinding, host unmount, refreshing persisted state on mount, legacy
data migration, and — after simulating a write from another window — the old binding no longer firing
while the new one fires immediately; shared contract tests cover converting `Mod` into an Electron
accelerator and `$mod` compatibility. The `AppInitializer` platform-timing test continues to cover the
single host entry point. The desktop P0 E2E opens a second real window through the product
`app.openWindow` IPC, sharing one Electron session/localStorage, and covers the default `Mod+K` and
physical punctuation `Mod+,` in both renderers, rebinding the sidebar in the main window to
`Mod+Shift+9` (which produces a shifted character), the old binding failing and the new one taking
effect immediately in both windows, and user bindings restored after reloading the auxiliary renderer.

Requirement: [Issue #288](https://github.com/LodyAI/Lody/issues/288).
PR: [#572](https://github.com/LodyAI/Lody/pull/572).
