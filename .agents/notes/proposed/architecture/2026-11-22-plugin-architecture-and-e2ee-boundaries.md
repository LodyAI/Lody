# Plugin architecture refinements and E2EE workspace boundaries

Status: proposed
Translation: current

[简体中文](2026-11-22-plugin-architecture-and-e2ee-boundaries.zh.md)

## Abstract

Reviewing the initial [Lody Plugin System Spec](../../../../specs/plugin-system.md) exposed five structural gaps in the base SDK contract — full-`revision` Turn freezing aborting running tools during UI-only edits, silent unattributed blame inside the shared `PluginWorker`, missing live progress and per-Session storage GC for `defineTool`, string-interpolated `CodeMode` wait programs with user-only business keys, and silent Agent self-enablement — alongside an underspecified encrypted-workspace (E2EE) security model. This note proposes adding a third `machineDigest`, canary fault verification with read-only retry, running-state `ToolRenderProps` paired with `ctx.sessionDataDir`, parameterized read-only `waitCondition` programs with `businessKeyScope`, `lody plugin propose`, and nine concrete E2EE rules spanning Guest vs Writer RPC, per-project `MachineSharing`, signed `e2eeIntent` provenance, single-frame Iroh sizing, custody-scoped storage wipe, and telemetry/share redaction. These rules preserve existing E2EE wire envelopes and zero-CRDT-bloat history at the cost of forbidding Guest `useQuery` execution, restricting `'machine'` scope to the machine owner in E2EE, and rejecting un-rooted daemon `sessions.create` / `send`. Only the TypeScript SDK contracts and reference plugin fixtures are verified today; `PluginHost`, `ClientPluginHost`, and E2EE runtime gates remain unimplemented.

## Findings in the base plugin contract

### Emergent strengths worth preserving

1. **Zero-LLM action loops:** Pairing bounded `tool_call` history payloads (`MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES` = 16 KiB) with `useHost().composer.appendText` and `defineMutation` lets interactive triage cards drive multi-step workflows without spending tokens or round-tripping through an LLM Turn.
2. **24/7 headless sentinels without detached agent daemons:** Composing `defineObservation` with `sessions.create({ waitCondition })` turns a `headless` machine into an auditable event-driven worker while keeping every woken action inside standard Session Inbox admission, permissions, and immediate Stop.
3. **Offline-resilient logical workspace views:** Keeping `WorkspaceRef` free of `machineId` lets multi-machine sidebars (`hostQueries.machines` / `projects` / `sessions`) render immediately from synced catalog state even when individual dev machines are offline, fanning out per `MachineRef` only where live machine state is needed.

### Structural gaps and proposed contract refinements

1. **Tri-digest split (`clientDigest`, `machineDigest`, `revision`):** Freezing full `revision` at Agent Turn start meant tweaking CSS in `client.tsx` or wording in `skills/` during `--dev` HMR broke in-flight tool calls on a multi-minute Turn. Adding `machineDigest = SHA-256(manifest.machine + machine.js + toolSchemas)` lets active Turns freeze `(pluginId, machineDigest)` while `client ↔ machine` RPC still checks full `revision` and browser trust/caching still binds `clientDigest`.
2. **Read-vs-write `PluginWorker` recovery and canary quarantine:** Sharing one `child_process.fork` `PluginWorker` per machine keeps memory flat (`~40–60 MiB` instead of `N` Node processes), but synchronous hangs or V8 heap OOMs have no stack attribution — blaming whichever plugin happened to have an in-flight `defineQuery` would falsely quarantine healthy plugins. On worker crash/watchdog restart:
   - In-flight `defineQuery` and `defineObservation` calls transparently retry once in the replacement worker, and transient `worker_restarted` / `unavailable` observation errors are excluded from Automation's 5-consecutive-error permanent `failed` threshold.
   - In-flight `defineMutation` and `defineTool` calls return `outcome_unknown` without automatic replay.
   - Unattributed hangs or OOMs replay suspect plugins inside a short-lived isolated canary worker before marking an installation `plugin_faulted`.
3. **Live `running` tool cards + `ctx.sessionDataDir` lifecycle:** Waiting until tool completion to mount `ToolRenderProps` left 3-minute test suites or builds opaque, yet streaming partial tool outputs through `HistoryWriter` would cause severe Loro CRDT write amplification and E2EE content-frame churn. Mounting `ToolRenderProps` during `status: 'running'` (`toolCallId`, `output?: undefined`) lets tools write incremental state to host-managed `ctx.sessionDataDir` and push UI refreshes via `ctx.invalidate` + `useQuery`, persisting only one ≤16 KiB snapshot on completion. Unlike installation-wide `ctx.dataDir`, `ctx.sessionDataDir` is deleted when the Session is deleted and isolated across `session/fork`.
4. **Scoped business keys, unbound `MachineRef` Sessions, and safe `waitCondition`:**
   - Widening `sessions.create` and `drafts.open` from `ProjectRef` to `MachineRef | ProjectRef` matches unbound Lody Sessions (`SessionPanelProps.project === undefined`).
   - Adding `businessKeyScope: 'user' | 'project'` (default `'user'`) allows team panels (`businessKeyScope: 'project'`) to deduplicate one active watch Session per issue across collaborators while keeping `requestId` strictly user-scoped.
   - Adding `waitCondition.params` (`ctx.params` in [`codemode.ts`](../../../../apps/cli/src/automations/programs/codemode.ts)) eliminates JS source string interpolation (`JSON.stringify` injection footguns), runs plugin wait programs in **read-only `CodeMode`** (`ctx.exec` disabled), adds optional observation `{ value, revision }` evidence for wakeup admission re-verification, and widens `ctx.invalidate` to accept `ObservationDescriptor` for push-assisted wakeup hints.
5. **Card-to-panel coordination, bounded `results.add`, and `lody plugin propose`:**
   - `host.panels.openSession(session, panelId, params?)` (`SessionPanelProps.params`) lets a compact tool card open a companion Session side panel at a specific item without module-global state hacks.
   - `lody.results.add(mimeType, ...)` shares the same 16 KiB bounded history contract as `defineTool`, rendering structured MCP/ACP resource blocks produced by any agent or external MCP server.
   - Because `machine` plugins run with the daemon OS user's authority and access `ctx.env`, Coding Agents inside Lody must never silently run `lody plugin enable`; `lody plugin propose <dir>` emits an explicit user-approval card mirroring `AgentRoleProposalNotice`.

## Encrypted (E2EE) workspace boundaries

Extending plugins into E2EE workspaces ([`specs/e2ee-foundations.md`](../../../../specs/e2ee-foundations.md)) touches nine distinct security boundaries beyond basic RPC encryption:

### 1. Guest (`read`) vs Writer (`admin` / `member`) RPC split

In [`e2ee-rpc.ts`](../../../../packages/shared/src/e2ee-rpc.ts) and [E2EE read queries](../../implemented/architecture/2026-10-28-e2ee-read-queries.md), `E2EE_READ_QUERY_METHODS` admits `read`-role Guests only to bounded, host-owned read methods because _"a method name cannot prove read-only."_ A plugin's `defineQuery` runs arbitrary Node code inside `PluginWorker` with access to `ctx.env` secrets and local disk, so `plugin/query` cannot be treated as a safe E2EE Guest read.

- **Allowed in `E2EE_READ_QUERY_METHODS`:** Only host-static `plugin/catalog` (enabled plugin metadata + digests) and `plugin/bundle-chunk` (immutable static `client.js` / `assets/` bytes). Guests can verify `clientDigest`, trust UI bundles, and render ≤16 KiB inline `tool_call` history cards read-only.
- **Gated by non-Guest `authorizeExecution` (`<15 min` verified RAM ledger freshness):** `plugin/query`, `plugin/mutate`, and `plugin/attachment-*`. On Guest clients, `useQuery` resolves cleanly to `{ status: 'unavailable', reason: 'forbidden' }`.

### 2. Machine owner vs per-project `MachineSharing`

Per [`specs/e2ee/machine-sharing.md`](../../../../specs/e2ee/machine-sharing.md) and [`packages/e2ee-machine-sharing/AGENTS.md`](../../../../packages/e2ee-machine-sharing/AGENTS.md), E2EE machines are private to their owner by default and shared per project (`MachineSharing` state). One developer machine often hosts both shared team projects and private unshared repositories.

- **Machine-owner-only:** Installing, enabling, disabling, or `--dev`-reloading plugins; writing `binding: 'installation'` settings or `ctx.env` secrets; and invoking any `'machine'`-scoped `defineQuery` / `defineMutation` (preventing cross-project leakage from unshared projects on that machine).
- **Project-collaborator-callable:** `'project'`- and `'session'`-scoped plugin queries, mutations, and attachment sources, re-verified on every call that `MachineSharing` currently shares both the target `machineId` and every project bound to that `ProjectRef` or `SessionRef` (unbound E2EE Sessions remain owner-only).

### 3. Signed execution-intent provenance (`e2eeIntent`) and 20-derivation quota

Per [`e2ee-execution-intent.ts`](../../../../packages/shared/src/e2ee-execution-intent.ts), [signed execution intent](../../implemented/architecture/2026-11-10-e2ee-signed-execution-intent.md), and [shared-member derivation](../../implemented/architecture/2026-10-31-e2ee-shared-member-derivation.md), E2EE machines refuse unsigned Session prompts:

- **Client `useHost().sessions.create` / `send`:** Signs a fresh `memberInput` (`kind = 1`) on the user's personal device (`local` desktop or `web` custody) over the exact normalized prompt, attachment snapshots, and `waitCondition` before RPC dispatch.
- **Daemon `ToolExecutionContext.host.sessions.create` / `send`:** Signs a `machineInput` (`kind = 2`) carrying `derivedFrom: { sessionId, userTurnId }` anchored to the verified human root Turn currently executing the tool. Shared-member root Turns inherit the hard **20-derivation reservation quota** and **single-machine derivation rule** (`e2ee_derivation_cross_machine_unsupported` if targeting another machine).
- **Un-rooted daemon `MachineContext` (`defineMutation` / `defineObservation`):** Rejects `host.sessions.create` and `host.sessions.send` with `forbidden` in E2EE workspaces, ensuring `plugin/mutate` can never act as an unsigned prompt-signing oracle on the machine key.
- **Read-only `waitCondition` binding:** Because `CreateSessionRequest.waitCondition` runs later on the daemon when waking a `waiting` Session, its static source and `params` are bound inside the creator's signed `memberInput` (or `derivedFrom` `machineInput`) and restricted to read-only `CodeMode` (`ctx.exec` disabled) so shared project collaborators cannot run arbitrary OS shell commands outside project git/session boundaries.

### 4. Transport framing: 256 KiB single-frame Iroh fast path vs paged bundle reads

Per [E2EE Iroh transport](../../implemented/architecture/2026-11-10-e2ee-iroh-transport.md), Desktop↔Machine E2EE RPC uses a direct QUIC P2P fast path (`~112 ms` median latency, surviving Streams control-plane outages) only for single-frame `purpose 8` requests (`≤ 1 MiB` envelope), falling back to multi-envelope Streams (`~733 ms`) above that ceiling:

- Capping `plugin/query` and `plugin/mutate` requests at **`MAX_PLUGIN_RPC_REQUEST_BYTES` (256 KiB)** guarantees encrypted envelopes stay comfortably inside one 1 MiB `purpose 8` Iroh frame on desktop while browser `web` clients route over encrypted Streams RPC.
- `plugin/bundle-chunk` reuses the existing 256 KiB `purpose 9` paged read response machinery (`MAX_PACKED_CLIENT_BUNDLE_BYTES` = 4 MiB, well below the 16 MiB 64-page E2EE read ceiling), requiring zero wire-protocol changes to `specs/e2ee-foundations.md`.

### 5. Client bundle/trust custody and terminal wipe on revocation or removal

In E2EE workspaces, custom `--dev` or internal packed `client.js` bundles embed proprietary domain schemas, internal issue templates, and workflow logic. Storing them in global plaintext IndexedDB keyed only by `clientDigest` would leak workspace-private code onto shared browser profiles and survive member removal:

- E2EE client bundle caches, trust grants, and persistent UI plugin state must bind to `<account>/<workspace>/<genesis>/<signing-key>` under host custody ([`specs/e2ee/client-custody.md`](../../../../specs/e2ee/client-custody.md), [`specs/e2ee/desktop-custody.md`](../../../../specs/e2ee/desktop-custody.md)) — wrapped with the installation KEK / active workspace content key, or held strictly in memory while the verified E2EE runtime scope is open.
- `ClientPluginHost` stays gated behind `RuntimeProvider` E2EE mode and epoch admission ([`packages/platform/AGENTS.md`](../../../../packages/platform/AGENTS.md)), never mounting cached E2EE plugins while workspace mode is `unknown`.
- Confirmed `e2ee_member_removed` or `e2ee_device_revoked` terminal outcomes atomically wipe that `<account>/<workspace>/<genesis>/<signing-key>` plugin bundle cache and trust store alongside managed E2EE content.

### 6. Daemon `dataDir` / `sessionDataDir` custody and identity-lease lifecycle

Per [`apps/cli/src/lib/e2ee/AGENTS.md`](../../../../apps/cli/src/lib/e2ee/AGENTS.md):

- E2EE plugin `dataDir` and `sessionDataDir` live under `e2ee/<account-hash>/<workspace>/content/<genesis>/<signing-key>/plugins/<pluginId>/` with owner-only directory permissions (`0700` / Windows owner DACL) and symlink rejection, never sharing paths with plaintext workspaces or across re-keyed identities.
- Local identity reset archives the old identity subtree without deleting uncommitted recovery evidence, whereas confirmed `RemoveMember` erases the workspace's plugin `dataDir` / `sessionDataDir` subtree during managed-content cleanup.

### 7. Ephemeral presence allowlists and telemetry redaction

- Ephemeral presence frames carry a strict field allowlist (`specs/e2ee-foundations.md`): active plugin IDs, custom sidebar/panel IDs, and running plugin tool names are stripped before presence publication.
- Telemetry (`packages/platform/AGENTS.md`) suppresses replay in E2EE workspaces and records only fixed host error codes (`revision_mismatch`, `plugin_faulted`, `outcome_unknown`), never plugin IDs, Zod validation diffs, or guest stack traces.

### 8. Static plaintext Session sharing

Per [plaintext share consent](../../implemented/feature/2026-10-28-e2ee-share-plaintext-consent.md):

- Explicit per-Session plaintext share consent includes inline ≤16 KiB `tool_call` history payloads already present in the Session transcript, while never uploading files from daemon `ctx.dataDir` or `ctx.sessionDataDir`.
- Public share viewers opened by anonymous readers render Lody's built-in structured JSON/table fallback for plugin `tool_call` blocks rather than fetching or executing third-party `client.js` bundles outside an authenticated workspace trust context.

### 9. Outbound credential egress and zero cloud-broker tokens

- Per `apps/cli/src/lib/e2ee/AGENTS.md`, E2EE daemons receive zero cloud-hosted GitHub installation tokens or hosted credential brokers; plugins only see secrets explicitly configured in `ctx.env` by the machine owner.
- Enabling an E2EE plugin that declares `env`, `attachmentSource`, `mcpServers`, or `acpProviders` surfaces an explicit machine-owner disclosure that `machine` code runs with local OS network access and may transmit inputs to external APIs configured by that plugin.

## Rejected alternatives

1. **Admitting `plugin/query` into `E2EE_READ_QUERY_METHODS` for Guest readers:** Rejected because `defineQuery` executes arbitrary plugin Node code inside `PluginWorker` with access to `ctx.env` and local files; allowing Guests to invoke `plugin/query` would violate the core E2EE invariant that Guest `read` access never triggers arbitrary code or secret-bearing operations on a machine.
2. **Global content-addressed IndexedDB cache (`clientDigest` only) shared across E2EE workspaces:** Rejected because internal `--dev` and enterprise-packed `client.js` bundles contain proprietary business logic, prompts, and internal endpoint names that must remain confined to `<account>/<workspace>/<genesis>/<signing-key>` custody and be wiped upon member removal or device revocation.
3. **Allowing daemon `defineMutation` or `defineObservation` to sign `machineInput` without `derivedFrom`:** Rejected because any collaborator able to trigger `plugin/mutate` (or an external webhook hitting an observation) could mint fresh agent execution without a personal-device `memberInput` signature or root-Turn derivation cap, turning `PluginHost` into an execution-signing oracle.
4. **Streaming intermediate `defineTool` progress through Loro `HistoryWriter`:** Rejected because high-frequency progress updates (e.g. hundreds of test cases completing) would bloat permanent Loro history documents and multiply E2EE content encryption frames; mounting `ToolRenderProps` in `running` state over `useQuery` + `ctx.invalidate` achieves live UI with zero CRDT or E2EE history overhead.
5. **Spawning one OS utility process per enabled plugin, or blindly quarantining in-flight plugins on shared-worker hang:** Per-plugin Node processes multiply baseline RAM across headless machines, while blaming whichever plugin had an unrelated `defineQuery` in flight during a synchronous infinite loop causes false-positive `plugin_faulted` outages; verifying suspects in a short-lived canary worker preserves single-worker efficiency with accurate fault isolation.

## Consequences and open limits

- **Honest E2EE Guest degradation:** Guests in E2EE workspaces see rich custom history cards from inline ≤16 KiB `tool_call` snapshots, while live `useQuery` expansions (for >16 KiB details in `sessionDataDir`) render `{ status: 'unavailable', reason: 'forbidden' }`.
- **Daemon-initiated Sessions in E2EE require either a client click or an active human-rooted Turn:** Autonomous 24/7 E2EE sentinels must be armed up front via a personal-device-signed `sessions.create({ waitCondition })` (`memberInput`), which wakes later under its pre-signed intent, rather than calling `sessions.create` dynamically inside an un-rooted `defineObservation`.
- **Mobile native surfaces remain open:** `apps/mobile` continues to use built-in structured fallbacks because React Native / mobile WebView evaluation of plugin `client.js` bundles is not part of Phase 1–3.

## Verification

- [`scripts/plugin-sdk-contracts.test.mjs`](../../../../scripts/plugin-sdk-contracts.test.mjs) compiles [`sdk/shared.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/shared.d.ts), [`sdk/client.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/client.d.ts), [`sdk/machine.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/machine.d.ts), [`contracts.ts`](../../../../scripts/fixtures/plugin-sdk/contracts.ts), [`machine-contracts.ts`](../../../../scripts/fixtures/plugin-sdk/machine-contracts.ts), and four reference plugins (`test-report`, `issue-context`, `worktrees`, `focus-sidebar`) under isolated browser-pure and Node-only TypeScript configurations, covering running-state `ToolRenderProps`, `ctx.sessionDataDir`, `MachineRef | ProjectRef` session creation, `businessKeyScope`, `waitCondition.params`, observation `revision` + `ctx.invalidate`, `host.panels.openSession`, and RPC/bundle byte ceilings, plus temporary-file persistence fault-injection tests for `issue-context`.
- Unverified pending implementation: `PluginHost`, `ClientPluginHost`, `PluginWorker` canary quarantine, `sessionDataDir` GC/fork isolation, `lody plugin propose`, and all E2EE RPC, `MachineSharing`, `e2eeIntent`, and custody-wipe integrations.
