# Client snapshot reads

[中文](README.zh.md)

`useLodySnapshot` observes the same authorized workspace data as `lody.readSnapshot`.
A plugin installation shares a source lease among subscribers to the same target.
The last unsubscribe releases it. Commits invalidate the selected source; no
raw snapshot is built without an observer or an explicit read. The returned
JSON is detached and deeply frozen. Supply `isEqual` when a selector creates a
new object but only changes to its contents should repaint the panel.

- `workspace-state`: `sessions`, `projects` (visible local copies), `agentRoles`,
  and `schedules` are keyed by ID (`machineId:localProjectId` for a local copy).
  `workspaceProjects`, `pinSections`, `mcpServers`, and `projectMcpDefaults`
  come from the workspace catalog. Pass a `path` to read only a subtree.
- `project-state` and `session-meta`: the visible local project record or Session
  metadata. Only the creating plugin can read a Session's `businessKey`.
- `session-transcript`: `{ turns }` from the session's Loro or Roost history
  reader. Pass up to 100 `turnIds` for specific turns, or a `limit` from 1 to
  100 for a recent window (default 20).
- `schedule-doc`: the document from the workspace's schedule store.

The client does not expose writer handles, environment maps, authentication
headers, or cryptographic custody fields. This redaction concerns structured
host fields; it does not classify arbitrary text a user or agent wrote in a turn.
