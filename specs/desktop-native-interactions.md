# Desktop native interactions

Status: draft
Translation: pending

## Scenario and behavior

When a desktop user selects a local project, the directory picker starts at the
user's home directory. This explicit starting point avoids inheriting a changing
Electron default while leaving the user free to navigate elsewhere.

When the application sends a native session-completion notification, IPC reports
success only after Electron emits `show`. If Electron emits `failed`, the result
contains its failure reason. A synchronous setup failure is reported through the
same result contract.

Terminal text clipboard writes complete before their IPC invocation settles.
Image clipboard behavior remains on the Electron 39 API until the runtime
upgrade can adopt the incompatible Electron 44 `ClipboardItem[]` contract
atomically.

## Evidence

- [Native notification delivery](../apps/electron/src/main/services/notification-delivery.ts)
- [Local project selection](../apps/electron/src/main/ipc/services/local-projects-ipc.ts)
- [Terminal clipboard IPC](../apps/electron/src/main/ipc/services/terminal-ipc.ts)
