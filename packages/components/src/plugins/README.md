# Client plugin reads

[中文](README.zh.md)

Prefer normalized `lodyQueries` for offline UI. `sessionSetAnnotation` and `projectSetAnnotation` accept `{ value }` (JSON, at most 4 KiB serialized as UTF-8). The host chooses the installation's plugin ID; the synced summary exposes `annotations[pluginId]`.

A machine `ctx.invalidate` bumps the installation's catalog revision. The next catalog poll refreshes that plugin's cached queries without re-evaluating its module; the client does not match the invalidation target, so every query of the plugin refetches within the poll interval.

With explicit `unstable.rawState` permission, `lody.unstable.readSnapshot` and `useUnstableLodySnapshot` return detached, recursively frozen projections capped at 512 KiB, including their envelope. Field names are not SemVer-stable. An unobserved hook does not open a source; the last subscriber releases the lease.

- `workspace-state`: `path: [collection, key, ...fields]` selects one visible entity from `sessions`, `projects`, `machines`, `roles`, `schedules`, or `rateLimits`. Local project and rate-limit keys are machine-qualified (`machineId:localProjectId`, `machineId:rateLimitEntryKey`).
- `project-state`: provide a visible project and nonempty field path. `session-meta` selects a single visible Session. `businessKey` is visible only to its creating plugin.
- `session-transcript`: request either 1–100 explicit `turnIds` or a recent `limit` of 1–100, not both. The host reads only that window from the Session's history reader.
