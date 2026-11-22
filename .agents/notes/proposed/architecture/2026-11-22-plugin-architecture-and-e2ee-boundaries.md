# Plugin architecture refinements and E2EE workspace boundaries

Status: proposed
Translation: current

[简体中文](2026-11-22-plugin-architecture-and-e2ee-boundaries.zh.md)

## Abstract

Reviewing the initial [Lody Plugin System Spec](../../../../specs/plugin-system.md) exposed structural gaps in the base SDK contract — full-`revision` Turn freezing aborting running tools during UI-only edits, unattributed blame in the shared `PluginWorker`, missing live progress and per-Session storage GC for `defineTool`, watered-down host read projections that forced prop-stuffing and could not express custom multi-Agent sidebars or themes, and silent Agent self-enablement — alongside an underspecified encrypted-workspace (E2EE) security model. This note proposes a third `machineDigest`, canary fault verification with read-only retry, running-state `ToolRenderProps` with `ctx.sessionDataDir`, publishing Lody's raw reactive stores and authenticated network facade via `lodyQueries` (`useLodyQuery`) paired with full sidebar replacement (`lody.sidebar.replace`), portable `agentRoles`, VS Code `themes`, and opt-in shell/CSS extensions, plus nine concrete E2EE rules. These choices keep component props thin, avoid inventing a hardcoded `swarm` group entity in Lody core, and preserve E2EE wire envelopes at the cost of forbidding Guest `useQuery` execution, restricting `'machine'` scope to the machine owner in E2EE, and gating daemon session creation behind signed `e2eeIntent`. Only the TypeScript SDK contracts and reference plugin fixtures are verified today; runtime hosts and E2EE enforcement remain unimplemented.

## Findings in the base plugin contract

### Emergent strengths worth preserving

1. **Zero-LLM action loops:** Pairing bounded `tool_call` history payloads (`MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES` = 16 KiB) with `useHost().composer.appendText` and `defineMutation` lets interactive triage cards drive multi-step workflows without spending tokens or round-tripping through an LLM Turn.
2. **24/7 headless sentinels without detached agent daemons:** Composing `defineObservation` with `sessions.create({ waitCondition })` turns a `headless` machine into an auditable event-driven worker while keeping every woken action inside standard Session Inbox admission, permissions, and immediate Stop.
3. **Offline-resilient logical workspace views:** Keeping `WorkspaceRef` free of `machineId` lets multi-machine sidebars (`lodyQueries.machines` / `projects` / `sessions`) render immediately from synced catalog state even when individual dev machines are offline, fanning out per `MachineRef` only where live machine state is needed.

### Structural gaps and proposed contract refinements

1. **Published raw data & network SDK (`lodyQueries` + `useLodyQuery`) and full sidebar replacement (`lody.sidebar.replace`):**
   - **Thin props, pull-on-demand raw data:** Pre-stuffing derived state like `repositoryState` into `ProjectPageProps` or watering down [`SessionMeta`](../../../../packages/shared/src/schema.ts) into an 8-field summary forced host changes whenever a plugin needed another field. Publishing `lodyQueries` (`useLodyQuery` on `client`, `ctx.host.read` on `machine`) lets components accept only capability handles + route `params` and pull raw reactive Loro/Flock snapshots (`sessions` with `openedBySessionId` / `openedByRootSessionId` / `agentRoleId` / `contextWindowUsage`, `agentRoles`, `machines`, `projects`, `members`, `schedules`, `sessionDetail`) alongside Lody's authenticated `MachineRpc`/cloud network adapters (`gitState`, `worktrees`, `sessionDiff`, `filePreview`, `pullRequests`, `skills`).
   - **Custom sidebars instead of hardcoded Swarm groups:** Because `SessionMeta` already records `openedBySessionId`, `openedByRootSessionId`, and `agentRoleId`, exposing those raw fields to `lody.sidebar.replace` lets any multi-Agent plugin replace the default sidebar with its own parent/child Agent tree, Role swimlanes, or Kanban board without baking a rigid `swarm` group schema into Lody core.
2. **Portable multi-Agent Role blueprints, declarative settings, themes, and expressive shell/CSS hooks:**
   - **Portable `manifest.agentRoles` + `machine.onSessionEvent`:** Workspace `AgentRole` rows ([`agent-role.ts`](../../../../packages/shared/src/agent-role.ts)) bind user-specific `(machineId, agentConfigId)` pairs and cannot be shared across users as-is. Shipping machine-agnostic `agentRoles` blueprints in `lody.plugin.json` (mapped onto each user's own targets via `manifest.settings` `roleTarget` fields and launched via `pluginRoleId`) plus `machine.onSessionEvent` enables shareable multi-Agent teams with low-latency Turn handoffs.
   - **VS Code themes + opt-in local CSS/JS customization:** `manifest.themes` connects directly to Lody's VS Code theme engine ([`vscode-theme-dom.ts`](../../../../packages/components/src/lib/vscode-theme/vscode-theme-dom.ts)). Rather than locking desktop power users out of global UI customization, `manifest.styles` / `lody.styles.add` (against stable `data-lody-slot` DOM attributes), `lody.shell.overlays.add`, `lody.shell.statusBar.add`, and `lody.commands.add` run locally for the opting-in user without propagating to teammates' clients, backed by instant `lody --safe-mode` bypass.
3. **Tri-digest split (`clientDigest`, `machineDigest`, `revision`):** Freezing full `revision` at Agent Turn start meant tweaking CSS in `client.tsx`, themes, or wording in `skills/` during `--dev` HMR broke in-flight tool calls on a multi-minute Turn. Adding `machineDigest = SHA-256(manifest.machine + machine.js + toolSchemas)` lets active Turns freeze `(pluginId, machineDigest)` while `client ↔ machine` RPC still checks full `revision` and browser trust/caching still binds `clientDigest`.
4. **Read-vs-write `PluginWorker` recovery and canary quarantine:** Sharing one `child_process.fork` `PluginWorker` per machine keeps memory flat (`~40–60 MiB` instead of `N` Node processes), but synchronous hangs or V8 heap OOMs have no stack attribution — blaming whichever plugin happened to have an in-flight `defineQuery` would falsely quarantine healthy plugins. On worker crash/watchdog restart:
   - In-flight `defineQuery` and `defineObservation` calls transparently retry once in the replacement worker, and transient `worker_restarted` / `unavailable` observation errors are excluded from Automation's 5-consecutive-error permanent `failed` threshold.
   - In-flight `defineMutation` and `defineTool` calls return `outcome_unknown` without automatic replay.
   - Unattributed hangs or OOMs replay suspect plugins inside a short-lived isolated canary worker before marking an installation `plugin_faulted`.
5. **Live `running` tool cards, `ctx.sessionDataDir`, scoped business keys, safe `waitCondition`, and `lody plugin propose`:**
   - Mounting `ToolRenderProps` during `status: 'running'` (`toolCallId`, `output?: undefined`) lets tools write incremental state to host-managed `ctx.sessionDataDir` (reaped on Session deletion and isolated across `session/fork`) and push UI refreshes via `ctx.invalidate` + `useQuery` with zero Loro CRDT bloat.
   - Widening `sessions.create` and `drafts.open` to `MachineRef | ProjectRef`, adding `businessKeyScope: 'user' | 'project'`, passing structured `waitCondition.params` (`ctx.params` in read-only [`codemode.ts`](../../../../apps/cli/src/automations/programs/codemode.ts) with `ctx.exec` disabled), adding `host.panels.openSession`, and gating Agent-authored plugins behind `lody plugin propose` close the remaining orchestration and privilege-escalation gaps.

## Encrypted (E2EE) workspace boundaries

Extending plugins into E2EE workspaces ([`specs/e2ee-foundations.md`](../../../../specs/e2ee-foundations.md)) touches nine distinct security boundaries beyond basic RPC encryption:

### 1. Guest (`read`) vs Writer (`admin` / `member`) RPC split

In [`e2ee-rpc.ts`](../../../../packages/shared/src/e2ee-rpc.ts) and [E2EE read queries](../../implemented/architecture/2026-10-28-e2ee-read-queries.md), `E2EE_READ_QUERY_METHODS` admits `read`-role Guests only to bounded, host-owned read methods because _"a method name cannot prove read-only."_ A plugin's `defineQuery` runs arbitrary Node code inside `PluginWorker` with access to `ctx.env` secrets and disk, so `plugin/query` cannot be treated as a safe E2EE Guest read.

- **Allowed in `E2EE_READ_QUERY_METHODS`:** Only host-static `plugin/catalog` and `plugin/bundle-chunk` (alongside existing host-verified read queries backing `useLodyQuery`). Guests can verify `clientDigest`, trust UI bundles, and render ≤16 KiB inline `tool_call` history cards or read-only views.
- **Gated by non-Guest `authorizeExecution` (`<15 min` verified RAM ledger freshness):** `plugin/query`, `plugin/mutate`, and `plugin/attachment-*`. On Guest clients, `useQuery` against plugin descriptors resolves cleanly to `{ status: 'unavailable', reason: 'forbidden' }`.

### 2. Machine owner vs per-project `MachineSharing`

Per [`specs/e2ee/machine-sharing.md`](../../../../specs/e2ee/machine-sharing.md) and [`packages/e2ee-machine-sharing/AGENTS.md`](../../../../packages/e2ee-machine-sharing/AGENTS.md), E2EE machines are private to their owner by default and shared per project (`MachineSharing` state). One developer machine often hosts both shared team projects and private unshared repositories.

- **Machine-owner-only:** Installing, enabling, disabling, or `--dev`-reloading plugins; writing `binding: 'installation'` settings or `ctx.env` secrets; and invoking any `'machine'`-scoped `defineQuery` / `defineMutation` (preventing cross-project leakage from unshared projects on that machine).
- **Project-collaborator-callable:** `'project'`- and `'session'`-scoped plugin queries, mutations, and attachment sources, re-verified on every call that `MachineSharing` currently shares both the target `machineId` and every project bound to that `ProjectRef` or `SessionRef` (unbound E2EE Sessions remain owner-only).

### 3. Signed execution-intent provenance (`e2eeIntent`) and 20-derivation quota

Per [`e2ee-execution-intent.ts`](../../../../packages/shared/src/e2ee-execution-intent.ts), [signed execution intent](../../implemented/architecture/2026-11-10-e2ee-signed-execution-intent.md), and [shared-member derivation](../../implemented/architecture/2026-10-31-e2ee-shared-member-derivation.md), E2EE machines refuse unsigned Session prompts:

- **Client `useHost().sessions.create` / `send`:** Signs a fresh `memberInput` (`kind = 1`) on the user's personal device (`local` desktop or `web` custody) over the exact normalized prompt, attachment snapshots, and `waitCondition` before RPC dispatch.
- **Daemon `ToolExecutionContext.host.sessions.create` / `send`:** Signs a `machineInput` (`kind = 2`) carrying `derivedFrom: { sessionId, userTurnId }` anchored to the verified human root Turn currently executing the tool. Shared-member root Turns inherit the hard **20-derivation reservation quota** and **single-machine derivation rule** (`e2ee_derivation_cross_machine_unsupported` if targeting another machine).
- **Un-rooted daemon `MachineContext` (`defineMutation`, `defineObservation`, `onSessionEvent`):** Rejects `host.sessions.create` and `host.sessions.send` with `forbidden` in E2EE workspaces, ensuring daemon handlers without an active human root Turn can never act as an unsigned prompt-signing oracle on the machine key.
- **Read-only `waitCondition` binding:** Because `CreateSessionRequest.waitCondition` runs later on the daemon when waking a `waiting` Session, its static source and `params` are bound inside the creator's signed `memberInput` (or `derivedFrom` `machineInput`) and restricted to read-only `CodeMode` (`ctx.exec` disabled) so shared project collaborators cannot run arbitrary OS shell commands outside project git/session boundaries.

### 4. Transport framing: 256 KiB single-frame Iroh fast path vs paged bundle reads

Per [E2EE Iroh transport](../../implemented/architecture/2026-11-10-e2ee-iroh-transport.md), Desktop↔Machine E2EE RPC uses a direct QUIC P2P fast path (`~112 ms` median latency, surviving Streams control-plane outages) only for single-frame `purpose 8` requests (`≤ 1 MiB` envelope), falling back to multi-envelope Streams (`~733 ms`) above that ceiling:

- Capping `plugin/query` and `plugin/mutate` requests at **`MAX_PLUGIN_RPC_REQUEST_BYTES` (256 KiB)** guarantees encrypted envelopes stay comfortably inside one 1 MiB `purpose 8` Iroh frame on desktop while browser `web` clients route over encrypted Streams RPC.
- `plugin/bundle-chunk` reuses the existing 256 KiB `purpose 9` paged read response machinery (`MAX_PACKED_CLIENT_BUNDLE_BYTES` = 4 MiB, well below the 16 MiB 64-page E2EE read ceiling), requiring zero wire-protocol changes to `specs/e2ee-foundations.md`.

### 5. Client bundle/trust custody and terminal wipe on revocation or removal

In E2EE workspaces, custom `--dev` or internal packed `client.js` bundles embed proprietary domain schemas, internal issue templates, and workflow logic. Storing them in global plaintext IndexedDB keyed only by `clientDigest` would leak workspace-private code onto shared browser profiles and survive member removal:

- E2EE client bundle caches, trust grants, and persistent plugin settings must bind to `<account>/<workspace>/<genesis>/<signing-key>` under host custody ([`specs/e2ee/client-custody.md`](../../../../specs/e2ee/client-custody.md), [`specs/e2ee/desktop-custody.md`](../../../../specs/e2ee/desktop-custody.md)) — wrapped with the installation KEK / active workspace content key, or held strictly in memory while the verified E2EE runtime scope is open.
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
- Enabling an E2EE plugin that declares `env`, `attachmentSource`, `mcpServers`, or `acpProviders` surfaces an explicit machine-owner disclosure that `machine` code runs with host OS network access and may transmit inputs to external APIs configured by that plugin.

## Rejected alternatives

1. **Baking a dedicated `swarm` / `group` entity into Lody core and pre-stuffing raw data into surface props:** Rejected because Lody's `SessionMeta` already tracks `openedBySessionId`, `openedByRootSessionId`, and `agentRoleId`; publishing raw `lodyQueries` (`useLodyQuery`) + `lody.sidebar.replace` lets plugins build arbitrary multi-Agent trees, Role lanes, or dashboards without rigid host grouping schemas or bloated React props/context.
2. **Forbidding all global CSS and shell overlays across `local` desktop plugins:** Rejected because over-restricting user-enabled appearance/shell plugins stifles creative workflows (themes, HUDs, ambient status widgets, CSS snippets); scoping `styles` and `shell.*` to the opting-in local client without cross-user auto-propagation and pairing them with `lody --safe-mode` preserves safety without killing extensibility.
3. **Admitting `plugin/query` into `E2EE_READ_QUERY_METHODS` for Guest readers:** Rejected because `defineQuery` executes arbitrary plugin Node code inside `PluginWorker` with access to `ctx.env` and host files; allowing Guests to invoke `plugin/query` would violate the core E2EE invariant that Guest `read` access never triggers arbitrary code or secret-bearing operations on a machine.
4. **Global content-addressed IndexedDB cache (`clientDigest` only) shared across E2EE workspaces:** Rejected because internal `--dev` and enterprise-packed `client.js` bundles contain proprietary business logic, prompts, and internal endpoint names that must remain confined to `<account>/<workspace>/<genesis>/<signing-key>` custody and be wiped upon member removal or device revocation.
5. **Allowing daemon `defineMutation`, `defineObservation`, or `onSessionEvent` to sign `machineInput` without `derivedFrom`:** Rejected because any collaborator able to trigger `plugin/mutate` (or an external webhook) could mint fresh agent execution without a personal-device `memberInput` signature or root-Turn derivation cap, turning `PluginHost` into an execution-signing oracle.
6. **Streaming intermediate `defineTool` progress through Loro `HistoryWriter`, or spawning one OS process per plugin:** Streaming deltas into Loro bloats CRDT history and E2EE content frames (solved by `running`-state `ToolRenderProps` + `useQuery`), while per-plugin Node processes multiply baseline RAM across headless machines (solved by a single shared `PluginWorker` + short-lived canary verification).

## Consequences and open limits

- **Honest E2EE Guest degradation:** Guests in E2EE workspaces see rich custom history cards from inline ≤16 KiB `tool_call` snapshots and synced `useLodyQuery` catalog state, while live `useQuery` calls against plugin `PluginWorker` handlers render `{ status: 'unavailable', reason: 'forbidden' }`.
- **Daemon-initiated Sessions in E2EE require either a client click or an active human-rooted Turn:** Autonomous 24/7 E2EE sentinels must be armed up front via a personal-device-signed `sessions.create({ waitCondition })` (`memberInput`) or inside a human-rooted `ToolExecutionContext` (`derivedFrom` `machineInput`), rather than calling `sessions.create` dynamically inside an un-rooted `defineObservation` or `onSessionEvent`.
- **Mobile native surfaces remain open:** `apps/mobile` continues to use built-in structured fallbacks because mobile evaluation of plugin `client.js` bundles is not part of Phase 1–3.

## Verification

- [`scripts/plugin-sdk-contracts.test.mjs`](../../../../scripts/plugin-sdk-contracts.test.mjs) compiles [`sdk/shared.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/shared.d.ts), [`sdk/client.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/client.d.ts), [`sdk/machine.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/machine.d.ts), [`sdk/manifest.d.ts`](../../../../scripts/fixtures/plugin-sdk/sdk/manifest.d.ts), [`contracts.ts`](../../../../scripts/fixtures/plugin-sdk/contracts.ts), [`machine-contracts.ts`](../../../../scripts/fixtures/plugin-sdk/machine-contracts.ts), and four reference plugins (`test-report`, `issue-context`, `worktrees`, `focus-sidebar`) under isolated browser-pure and Node-only TypeScript configurations, covering `lodyQueries` + `useLodyQuery`, `sidebar.replace`, portable `agentRoles`, `themes`, `styles`, `shell.*`, `onSessionEvent`, running-state `ToolRenderProps`, `ctx.sessionDataDir`, `businessKeyScope`, `waitCondition.params`, and RPC/bundle byte ceilings, plus temporary-file persistence fault-injection tests for `issue-context`.
- Unverified pending implementation: `PluginHost`, `ClientPluginHost`, `PluginWorker` canary quarantine, `sessionDataDir` GC/fork isolation, `lody plugin propose`, and all E2EE RPC, `MachineSharing`, `e2eeIntent`, and custody-wipe integrations.
