# Electron 44 desktop behavior

Status: draft
Translation: pending

## Scenario and behavior

A desktop user installs or updates to an Electron 44 build. Packaged macOS
releases require macOS 13 or later, and the application artifact declares that
minimum so the operating system and updater can reject incompatible installs.

When a user selects a local project, the directory picker starts at the user's
home directory instead of inheriting Electron's Downloads-directory default.
When the application sends a native session-completion notification, IPC reports
success only after Electron emits `show`; an Electron `failed` event returns its
failure reason.

This behavior migration does not upgrade electron-vite or the desktop Vite
runtime. Those toolchain versions remain independent compatibility decisions.

## Evidence

- [Desktop package configuration](../apps/electron/electron-builder.yml)
- [Native notification delivery](../apps/electron/src/main/services/notification-delivery.ts)
- [Local project selection](../apps/electron/src/main/ipc/services/local-projects-ipc.ts)
- [Desktop build documentation](../apps/electron/README.md)
