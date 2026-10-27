# Encrypted workspace settings

Parent settings/component rules apply. Edit `AGENTS.md`, not `CLAUDE.md`.

- Public facts and permission hints come from the native verified ledger. Main
  rechecks every action; the renderer never receives keys or arbitrary signing.
- Rotation is manual only. Keep installation/ACK continuation visible after the
  ledger flag clears. Failures retain old sends and local data; never clear queues.
- Ordinary settings never open management ports. Scope probes and late results by
  account/workspace; notify only the corresponding provider after verified refresh.
- Pure panel stories use synthetic states; the hook/wrapper own the real entry.
  [Decision](../../../../../../.agents/notes/proposed/architecture/2026-10-27-e2ee-manual-key-management.md).
