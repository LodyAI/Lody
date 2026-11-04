# Desktop native interactions

Status: draft
Translation: current

[中文](desktop-native-interactions.zh.md)

## Scenario and behavior

When a desktop user selects a local project, the directory picker starts at the
user's home directory. This explicit starting point avoids inheriting a changing
Electron default while leaving the user free to navigate elsewhere.

When the application sends a native session-completion notification, IPC reports
success only after Electron emits `show`. If Electron emits `failed`, the result
contains its failure reason. A synchronous setup failure is reported through the
same result contract.

Terminal text and image clipboard writes complete before their IPC invocation
reports success. Invalid images leave the clipboard untouched; rejected native
writes return a recoverable failure. The Electron 44 runtime and asynchronous
image clipboard implementation ship together.

The Electron 44 desktop requires macOS 13 or newer. macOS 12 is outside this
runtime's supported operating-system range.

## Evidence

- [Native notification delivery](../apps/electron/src/main/services/notification-delivery.ts)
- [Local project selection](../apps/electron/src/main/ipc/services/local-projects-ipc.ts)
- [Terminal clipboard IPC](../apps/electron/src/main/ipc/services/terminal-ipc.ts)
- [Image clipboard service](../apps/electron/src/main/services/image-export-service.ts)
