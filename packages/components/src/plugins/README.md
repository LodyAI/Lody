# Client plugin reads

[中文](README.zh.md)

`lody plugin pack ./my-plugin -o release.tgz > release.json` produces the archive and its npm pin. Publish that **exact archive** to the npm registry; repacking the source changes its integrity. Import `release.json` in **Settings → Plugins** to add the disclosure to the workspace. Importing the pin does not approve code execution. Local directory and archive installs remain machine-bound.

To install on the owning machine and publish the verified pin in one operation, run `lody plugin install-npm <name> <exact-version> --integrity <sha512-SRI> --encrypted-workspace <id>` and approve the daemon prompt.

In **Settings → Plugins**, enable “Install on my machines” for a pinned npm release to sign an opt-in for your own machines. New installations start disabled, with no copied secrets or workflow grants. Existing installations are never upgraded by sync. Turning sync off prevents future installations; it does not uninstall a copy. Keep the approving personal device online with this workspace open. It answers each target’s fresh nonce automatically, including outside Settings, but only for the exact signed release it remembers in local custody. Other personal devices do not inherit that approval.

When several machines run the same plugin, one client instance contributes workspace UI. A machine query or mutation uses the enabled target installation's transport and digest, not the machine that registered that UI. An offline target reports `machine_offline`; an online machine without the plugin reports `not_found`. There is no fallback to a different machine.

Screens use `/$workspaceName/p/$pluginId/$screenId`. `nav: "sidebar"` adds a sidebar link and Command Palette entry; `lody.screens.setParams` updates the search parameters of the active screen. Project pages have separate URLs and a page switcher. A Session opens a panel with `?panel=<pluginId>:<panelId>`, beside the conversation on wide layouts or in a drawer on compact layouts. If a device previously saw a local installation whose source machine is offline, it keeps the URL and reports the offline source without running cached local code.

Prefer normalized `lodyQueries` for offline UI. `sessionSetAnnotation` and `projectSetAnnotation` accept `{ value }` (JSON, at most 4 KiB serialized as UTF-8). The host chooses the installation's plugin ID; the synced summary exposes `annotations[pluginId]`.

Project configuration lives in the workspace Flock document, keyed by machine, plugin and local project ID. Clients can read a cached project value without connecting to the machine. Workspace npm settings write to the local workspace document without contacting the destination machine. Encrypted writes require a current verified machine-owner or shared-project grant and workspace write access. The complete values object for one plugin and project must fit in 16 KiB of UTF-8 JSON; a rejected write leaves the previous object intact.

A machine `ctx.invalidate` bumps the installation's catalog revision. The next catalog poll refreshes that plugin's cached queries without re-evaluating its module; the client does not match the invalidation target, so every query of the plugin refetches within the poll interval.

With explicit `unstable.rawState` permission, `lody.unstable.readSnapshot` and `useUnstableLodySnapshot` return detached, recursively frozen projections capped at 512 KiB, including their envelope. Field names are not SemVer-stable. An unobserved hook does not open a source; the last subscriber releases the lease.

- `workspace-state`: `path: [collection, key, ...fields]` selects one visible entity from `sessions`, `projects`, `machines`, `roles`, `schedules`, or `rateLimits`. Local project and rate-limit keys are machine-qualified (`machineId:localProjectId`, `machineId:rateLimitEntryKey`).
- `project-state`: provide a visible project and nonempty field path. `session-meta` selects a single visible Session. `businessKey` is visible only to its creating plugin.
- `session-transcript`: request either 1–100 explicit `turnIds` or a recent `limit` of 1–100, not both. The host reads only that window from the Session's history reader.

`composer.beforeSend` receives the expanded execution text on the personal device, including applicable first-turn Agent Config, Role, and skill instructions. The user confirms the final replacement, not an intermediate draft. Escape, rejection, timeout, or an installation unloading during its hook stops the send. Scheduling a message signs a schedule declaration instead of submitting a member input.
