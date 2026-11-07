# Shared runtime source and dependency updates

`runtime/vendor/cloud-runtime` is a 98-file snapshot of this monorepo's `ios/packages/cloud-runtime`, commit `216d24ee8163821783f6cbd41604c761fc61ee74` (`git archive <commit> ios/packages/cloud-runtime`). It additionally includes the reviewed, capability-refresh and directory Tab source from e7df50f files listed in PROVENANCE.json, copied verbatim from the iOS runtime. Its license is retained. `vendor/PROVENANCE.json` identifies the source and `vendor/SHA256.json` records every file. `npm --prefix runtime run snapshot:check` and every asset build reject changed, added or missing files and symlinks. The drift test modifies a disposable copy, never the actual snapshot.

For an intentional update:

1. Select and record a reviewed upstream commit. Export only `packages/cloud-runtime` into a temporary directory using `git archive <commit> packages/cloud-runtime`; do not copy a live checkout wholesale.
2. Compare that export against the current snapshot. Review protocol changes, licensing and browser dependencies. Preserve Android adaptation in `runtime/src`, outside the snapshot.
3. Replace the snapshot only after reviewing the diff; update PROVENANCE and SHA256 together. Generate hashes with the exported `hashes()` function in `runtime/snapshot.mjs`, directed at the reviewed source directory. No build regenerates the manifest automatically.
4. Run snapshot verification, `npm ci`, JS tests, asset build, JVM and Android bridge tests. Update `runtime/contract/fixtures.json` only for an intentional contract change. Capture actual WebView/WASM results and verify release assets contain no diagnostics.

The production lockfile remains pinned. Phase 1 reported Zod advisory **GHSA-mrhx-c7xc-m3w5** against 3.25.76. Phase 2 pins **4.6.7** and verifies real shared schemas: accepted identities, strict extra-field rejection, shortcut variants, share object validation, and oversized constrained collections failing before per-item error allocation. The oversized-input test failed on v3 and passes on the patched version. `npm audit --omit=dev` reports zero known vulnerabilities for this lockfile. No source snapshot changes or v3 compatibility shim were needed.

References: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 and https://zod.dev/v4/changelog. Audit evidence is retained separately for each phase.

Bridge protocol 2 adds an explicit command capability handshake, `$cancel`, native command deadlines, and ordered message chunks. It wraps the original JS runtime; it does not change the upstream cloud protocol. Fixtures use synthetic catalog data matching the vendored event shapes, not captured user data. The offline document exposes `ping`, `setActive`, and `probeSchema`. The network document additionally advertises `connect`, `grant`, `watchSession`, `closeSession`, `creationOptions`, and `createAndSend`, used through the native scoped runtime. Session reads reuse the upstream Loro projection and emit typed text messages to Compose. Both network gates restrict reads and the creation/dispatch writes described below to the current workspace; returning to the list stops the session subscription.

The snapshot carries every catalog field Android reads (session owner, `machineOs`, git
state, PR merge state), the 16 MiB per-replica catalog input budget and per-config
creation capabilities, so no bundle-time source adapters remain. A later difference
belongs in the next re-snapshot, not in a patch over the snapshot. `catalog-budget.test.mjs`
still runs the bundled watcher against a synthetic transport to pin the budget.

## Android text creation

`create-commands.mjs` exposes creation options and create-and-send using native scope identity. Presence is read through the grant origin; the UI only offers currently online agents. The adapter calls upstream creation, session bootstrap and text send in order, retaining IDs and never retrying writes. It deliberately uses plain text (no shortcut, attachment or mention expansion). The snapshot's creation carries the public local-project `useWorktree` field. Native and JavaScript network gates permit only the exact workspace stream kinds needed for persistence and dispatch. An accepted Machine RPC is not task completion. GitHub branches are entered by name in this first integration.

Creation keeps cached choices visible until presence is known. The open creation
page refreshes from catalog/presence events, not a timer. Selecting an online provider revalidates its cached capabilities with `machine/acp-capabilities-refresh` through the
existing machine RPC transport, coalesced per provider/runtime; failed probes may retry on a later selection after a 30-second cooldown. Discovery is bounded
and serialized per machine. Its progress frames are not final replies; validated
final capabilities are held in a workspace/config-scoped display overlay and
passed through the normal capability projection. These capabilities are synchronized from the shared iOS runtime snapshot.

Creation reads healthy machine replicas independently: another machine's failed
sync does not block its agents or session creation. `creationOptionsChanged`
wakes both native pickers even before the whole catalog can report synced.
Matching `acpModelCapability` source versions supply per-model effort/Fast
controls; mismatched declarations never overwrite current capabilities.

Agent discovery merges live `agent-*` repo metadata with machine Flock configs,
matching the daemon. Machine configs win by machine/config identity; deleted
metadata and agents outside readable healthy machines are excluded. Only display
fields reach native UI, never launch environments or credentials.
