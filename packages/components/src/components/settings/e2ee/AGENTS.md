# Encrypted workspace settings

Parent settings/component rules apply. Edit `AGENTS.md`, not `CLAUDE.md`.

- Public facts and permission hints come from the native verified ledger. Main
  rechecks every action; the renderer never receives keys or arbitrary signing.
- Rotation is manual only. Keep installation/ACK continuation visible after the
  ledger flag clears. Failures retain old sends and local data; never clear queues.
- Ordinary settings never open management ports. The encryption console dialog opens
  only on an explicit click and owns its own control reader (route rules apply). Scope probes and late results by
  account/workspace; notify only the corresponding provider after verified refresh.
- Pure panel stories use synthetic states; the hook/wrapper own the real entry.
  [Decision](../../../../../../.agents/notes/proposed/architecture/2026-10-27-e2ee-manual-key-management.md).
- Machine sharing uses only the native read/update ports, scoped by account,
  workspace, machine and verified generation. Render native ownership hints;
  main rechecks authority. Retry an unknown result with its original requestId
  and change; only explicit retry after confirmed conflict creates a new intent.
  Signer revocation preserves accepted grants; review/re-sign is nonblocking and preserves the list.
  [Decision](../../../../../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).

- Remote device pages retain the protected sharing panel without a local agent;
  this never enables general machine RPC or ordinary machine-sharing controls. Team management requires the current
  host's verified personal-device role and credential; replacement runtimes must
  qualify again before showing retained management controls.

- The recovery tab sets up every uncovered workspace through the port's
  `setupWorkspaces` (desktop main's `setupRecoveryForWorkspaces`), which unlocks the
  vault once and reports each
  workspace separately; one failed workspace never stops or rolls back the others.
  Only a committed, verified setup counts as done: pending, conflicting, unverified
  or missing results stay unfinished, and a saved but unverified workspace keeps its
  continue action.
  Keep at most one primary action on the tab, and exactly one whenever this host has
  a next step to offer. Give every failure card one next step that does something,
  with diagnostics secondary.
- The console's Recovery tab renders `RecoveryVaultSection` over the host's
  `RecoveryPort` (`recovery-port.ts`). A browser-shaped host (Web, the mobile webview)
  supplies its port through `E2eeRecoveryHostContext`; desktop wraps its main-process
  vault in `recovery-desktop-port.ts`. The section and `useWorkspaceRecoveryReady`
  never call IPC directly. The port is closed and returns outcomes only: the host owns
  every unlock, file picker and passkey ceremony, and no file bytes, vault handles or
  keys cross it.
- A host that cannot create, check or replace a recovery file sets that operation to
  null, and the section hides the action rather than offering one that dead-ends. A
  replacement such a host cannot continue is shown as one to finish on the device that
  started it, while restoring stays available and leads when it is the host's only next
  step. A passkey removal that settled keeps its outcome even when the host cannot read
  the list again; the section then drops the stale list instead of reporting a failure. A host-owned `Section` is accepted only
  while hosts move to the port. A host with neither, or with the renderer recovery switch
  off, composes no section: the console says recovery is unavailable on this device,
  never an empty tab, and offers no recovery shortcut. The section shows loading until
  its first plan answers; a host's `e2ee_recovery_disabled` refusal shows recovery as
  off with no actions. The switch never enables main's vault.
