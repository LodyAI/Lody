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
- Machine sharing uses only the native read/update ports, scoped by account,
  workspace, machine and verified generation. Render native ownership hints;
  main rechecks authority. Retry an unknown result with its original requestId
  and change; only explicit retry after confirmed conflict creates a new intent.
  Historical signer-revoked state is display/re-sign input, never execution evidence.
  [Decision](../../../../../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).

- Remote device pages retain the protected sharing panel without a local agent;
  this never enables general machine RPC or ordinary machine-sharing controls. Team management requires the current
  host's verified personal-device role and credential; replacement runtimes must
  qualify again before showing retained management controls.
