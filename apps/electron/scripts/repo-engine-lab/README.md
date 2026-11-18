# Native repository P0 acceptance

Run from a standalone checkout with the locked dependencies and the pinned Electron
binary prepared:

```sh
pnpm --dir apps/electron verify:repo-engine
```

This opt-in lab exercises the published engine/client/json-patch **0.1.0** packages.
It builds an isolated ASAR, unpacks only the matching native addon, loads that addon
inside real Electron, and connects two sandboxed renderers plus an independent Node
SDK client to one native host. It creates disposable data and user-data directories;
it does not attach to a running Lody daemon or open user workspaces. Native packages
are dev dependencies and are not added to the production embedded CLI staging chain.

The independent Node client is a synthetic daemon fixture, **not the product CLI**.
The lab UI is not the product chat UI. A passed result proves the native/IPC/ASAR
integration boundary, not complete Lody migration or multi-device cloud acceptance.
The transparent SDK bridge is confined to this disposable entry and must never be
installed on product windows; it exposes the full engine API. Product integration
requires the scoped domain IPC described in the migration plan.

The runner checks exclusive directory ownership, closing an attached client without
stopping the host, the shared directory reader against native Meta, renderer-to-Node
and Node-to-renderer history updates, Flock prefix updates/deletion/CAS, visibility
watermarks including another room, rejection of unsubscribed waiters, lost ACK
reconciliation without replay, host SIGKILL isolation/reconnect resets, and cold
Electron/host reopen. Waits use observable responses and deadlines, not launch sleeps.
Only test-owned child processes are signalled and reaped before deleting their state.

Each run retains its own `.test-build/repo-engine/<run-id>/` directory with compiled
inputs, ASAR/native assets, `result.json`, console log and a screenshot; failures also
retain renderer screenshots when available. Cleanup failures fail the run. Results
include the platform and must not be reused as another target's acceptance.

This does not prove signing/notarization, installed-app execution, power-loss
durability, cloud outbox recovery, persistent-room memory release, old-data migration,
or product E2EE. Roost is unchanged. The owning [migration plan](../../../../.agents/docs/electron-loro-repo-rs-migration.zh.md)
tracks the remaining P0 gates and P1–P4 cutover conditions.
