# Resolve ACP run controls per model (effort / fast)

Status: proposed
Translation: current
Language: [中文](2026-09-27-per-model-acp-controls.zh.md)

## Abstract

Lody treats the `configOptions` returned by `session/new` as the agent's whole
capability catalog and caches it per agent config, overwriting it each time. ACP
agents rebuild those options on every model switch, so the cache is really a
snapshot of one model. As a result the fast and effort controls appear, disappear,
or show the wrong values depending on which model the last created session started
with. The CLI then rejects valid requests, and Agent Role background reconciliation
deletes those keys from storage.

This proposal stores the `_meta.lody.modelCapabilities` declaration, which the
Claude and Codex adapters already publish but the host never reads, in a separate
Flock row. Controls are resolved per selected model and per field: whether a
control is supported, how it is encoded, and where that evidence came from and how
fresh it is. Every consumer shares these resolution rules. The offline catalog
only guides the UI and hints; it never rejects an effort/fast request. The daemon
computes the values it actually sends after switching the model, from the agent's
live options, and preferences stored in Roles and elsewhere are no longer deleted.

Sync volume is treated as a first-class constraint: the declaration row is about
1 KB with zero steady-state writes, and user intent is derived from existing turn
history with no new storage or writes. A pre-prompt safety check for permission and
Plan ships separately, before any validation is relaxed. Nothing has been
implemented or verified yet.

## Problem

### Current state (from reading `main` 2e0886b8)

- Cache: each agent config has one row `['acpCapability', AgentConfigId]` in the
  machine Flock, whose value is an `AcpCapabilityCacheEntry`
  (`packages/shared/src/ai.ts`). The key has no model dimension.
- Writes: both the one-off probe (`fetchAcpCapabilities`) and **every newly created
  session** (`scheduleCreatedSessionCapabilityUpdate`, `session-execution-service.ts`)
  rebuild the whole row from the `session/new` response. The latter runs before the
  user's selected model is applied, so the snapshot describes the model the agent
  started on. For Codex that is the default model in `~/.codex/config.toml`. Row
  deduplication uses `serializeAcpCapabilityWithoutFetchTime`
  (`apps/cli/src/lib/loro/doc.ts`). A new field must be added there explicitly, or
  a change to it is treated as "no change".
- The only per-model data is `modelReasoningEfforts`, derived from Codex's legacy
  `model[effort]` ids or from the Grok adapter's `_meta.lody.modelReasoningEfforts`.
  There is no per-model information about fast at all.
- Each consumer applies its own rules:
  - UI selectors: `normalizeReasoningEffortSelectors` (`acp-selector-options.ts`).
    Codex uses the hard-coded `CODEX_EXTENDED_REASONING_BY_MODEL`. Agents with a map
    rebuild effort per model. All others keep the snapshot. Whether the fast toggle
    appears depends entirely on the snapshot.
  - Composer: `resolveAcpSessionConfigSelection` (`acp-session-config-selection.ts`)
    keeps only keys covered by current selectors in its authoritative branch. Role
    application (`use-session-agent-role.ts`) and pre-creation filtering likewise
    drop values that have no selector.
  - Agent Role background reconciliation: `reconcileAgentRoleSchema`
    (`agent-role-schema-reconciliation.ts`) runs after a runtime probe. It
    **deletes** keys missing from the snapshot from the Role's persisted storage and
    bumps the revision. It does this even when the Role has no pinned model, so one
    probe can permanently lose fast/effort.
  - Schedules: `schedule-types.ts` checks permissions against the snapshot's
    `modes` / `configOptions`.
  - CLI: `validateTurnConfigOptionValues` and related functions
    (`apps/cli/src/commands/session.ts`). A key missing from the snapshot is
    **rejected** (`Unknown ACP config option ...: fast-mode`), and inherited values
    are **silently dropped**.
  - MCP: `measuredForModelId` / `unverifiedSelections` in `acp-run-config.ts`.
  - Runtime applier (`acp-session-config-applier.ts`): it **sets the mode first,
    then switches the model**, then sets the other options. It suppresses some
    rejection warnings for Claude/Codex. A successful `set_mode` writes the
    requested value back as if it were the result. It also has the name-based
    special case `shouldSkipFableFastModeDisable`.
- The runtime already tracks live state: `AgentClient` replaces the full option list
  on `config_option_update` and on `setSessionConfigOption` responses.
  `SessionAcpRuntimeConfigSnapshot` records only `id → currentValue`.

### User-visible consequences

- A real report on PR #333 (2026-09-23, timonwong): after setting Codex's default
  model to `grok-4.6`, Codex's Fast and Reasoning Effort controls disappeared in
  Lody. They came back after switching back to `gpt-5.6-sol` and refreshing.
- When switching models in the composer, the controls still belong to the snapshot
  model. Users can pick combinations the target model does not support, or miss
  controls only the target model has.
- Roles that worked for a long time get rejected by the CLI after the default model
  changes, or lose fast/effort to background reconciliation.
- Safety: when Claude switches to a model that lacks the current mode, it downgrades
  the mode to `default`. Because the applier sets the mode before switching the
  model, a requested `plan` can become `default` (wider permission) after the
  switch. The applier then writes the requested `set_mode` value back as the result,
  so the widening is invisible.

### Prior work

- Adapter side has landed: `LodyAI/acp-extension-claude#24` (`94223f1`) and
  `LodyAI/acp-extension-codex#31` (`9b4c961`) publish
  `_meta.lody.modelCapabilities = { version: 1, models: { [modelId]: { effortValues?, fastMode } } }`
  in the `session/new` response. Both adapters label it an advisory declaration
  about "this account right now", with live session state as the authority. The
  current submodule pointers include both commits, but no host code reads the
  declaration.
- The Grok adapter publishes the older `_meta.lody.modelReasoningEfforts`
  (effort only).
- PR #286 (merged) introduced `modelReasoningEfforts`. PRs #316 and #324 were closed
  and superseded by #333. Community PRs #344–#346 were closed.
- [Chat follow-up inherits the target run config](../../implemented/bug-fix/2026-09-17-chat-follow-up-inherits-target-run-config.md):
  follow-ups that omit parameters inherit the previous turn's config and drop
  incompatible inherited values. This proposal's CLI inheritance rule (section 4)
  partially supersedes the "drop incompatible inherited values" part: effort/fast
  intent is kept and left to projection.
- [Codex GPT-6 Sol/Luna reasoning](../../implemented/bug-fix/2026-09-24-codex-gpt6-sol-luna-reasoning.md):
  the Codex tier table needs manual maintenance for every new model. This proposal
  lets a fresh Codex declaration take precedence and keeps the table only as the
  fallback when there is no declaration.
- PR #333 (open, +4854/−840, `mergeable=CONFLICTING`) bundles four things: "a
  snapshot reports, it does not reject", a permission-widening guard with a one-time
  acceptance UX, reading `modelCapabilities`, and UI availability explanations.
  Judgment, not fact: its scope makes review and rollback hard. This proposal splits
  it by risk and reuses its conclusions and tests.

## Goals and non-goals

Goals:

1. The UI shows effort/fast availability and values for the **currently selected
   model** (for agents that declare them).
2. Offline data (snapshot or declaration) no longer causes effort/fast requests to be
   rejected, and values stored in Roles and elsewhere are no longer deleted.
3. For declaring agents, control availability no longer depends on which model the
   last snapshot captured. The snapshot still flips, but only affects descriptors
   and labels.
4. Per-model rules converge on one set of shared resolution rules, with separate
   display and dispatch entry points.
5. Permission and Plan get a pre-prompt safety check, shipped **before** any
   validation is relaxed.
6. No increase in steady-state sync volume (section 10). Whole-row rewrites of the
   existing capability row are out of scope; measure first, decide later.
7. Rolling back any step leaves things no worse than before that step shipped
   (possibly back to today's known defects). Rollback has an ordering constraint:
   PR4 must be rolled back before PR1.

Non-goals:

- Putting plan/permission into the per-model catalog. They go through PR1's safety
  check.
- A generic "full `configOptions` for every model" catalog (see alternative B).
- Persisting runtime observations ("live-observed"). An offline "unsupported" must
  never be learned from an option's absence.
- A one-time "accept wider permission" UX (#333's `acceptWiderPermissions`). PR1 only
  fails closed; whether that UX is needed is decided separately.
- Changing the upstream ACP protocol, or the Kimi / Pi / DeepSeek Harness adapters.

## Proposal

### 1. Three separate concepts

| Concept | Meaning | Stored in | Authority |
| --- | --- | --- | --- |
| Snapshot | One model's `configOptions` | Existing `acpCapability` row | Provides descriptors and labels; valid only for its `currentValue` model |
| Declaration | What each model can do, published by the adapter | **New** `acpModelCapability` row | Advisory; guides UI and hints |
| Runtime | A session's actual options and values right now | `AgentClient` / session doc | Authoritative for that session |

The model a snapshot describes can be read from the `currentValue` of its
`category: 'model'` option, so no new field is needed.

### 2. Storage: a separate declaration row

New Flock key `['acpModelCapability', AgentConfigId]` with value:

```ts
type AcpModelCapabilityDeclaration = {
  /** The adapter's declaration version, kept as-is; unknown versions are ignored whole. */
  version: 1;
  models: Record<ModelId, { effortValues?: string[]; fastMode?: boolean }>;
  /** Required: same source-version computation as the existing row (getAcpCapabilitySourceVersion). */
  sourceVersion: string;
};
```

The value holds **no timestamps or counters**. Every change to a row's value is
synced to every client in the workspace, and probes are very frequent (section 10).
Any field that changes on each probe would turn "content unchanged" into a write
and a sync.

Why not add a field to the existing row:

- The existing row is rebuilt wholesale by probes and by every new session. An older
  or downgraded daemon would wipe the new field on its next rebuild. The separate
  row is written only by new code, and old code neither recognizes nor touches it.
- `AcpCapabilityCacheEntrySchema` is `.strict()` and is used for
  `machine/acp-capabilities-refresh_response`. A new field in that response would make
  old clients fail to parse the whole response. The separate row stays out of that
  response; new data is read only through Flock.
- Old readers return `undefined` for unknown Flock row kinds and ignore them (row
  parsing in `machine-flock.ts`). Verified.
- The lifecycles differ: a declaration describes the whole model catalog, while a
  snapshot describes one model.
- Sync volume: the separate row is about 1 KB, while the existing row is 4–40 KB
  (Devin: 177 KB). A declaration change syncs only that 1 KB and does not drag the
  large row along.

Write rules. These are deliberately simple, because declarations **only affect UI
and hints and take no part in dispatch** (section 4).

- On receiving a v1 declaration (probe or session/new), compare the **whole value**
  with the stored one. Skip the write if equal; overwrite if different. Steady-state
  writes are zero.
- A missing declaration **does not delete** the existing row. An adapter omitting
  the declaration once does not mean the capability disappeared.
- The row is deleted together with its agent config.
- When `sourceVersion` differs from the value computed for the current agent
  config, resolution treats the declaration as absent. No delete is needed.
- **Write-sequence guard, kept in daemon memory**, with no Flock writes:
  - The daemon keeps a monotonically increasing request sequence number per agent
    config.
  - Each probe or session/new takes a new sequence number **when it starts**.
  - Authentication start, `authenticationRequired`, and agent config deletion also
    advance it.
  - A write goes through only if its sequence number is greater than both the last
    successful write's and the latest invalidation's.

  This stops probe A from writing after probe B within the same authentication
  period, and stops an old declaration from being written back after
  authentication.
- **No time-based TTL, and its cost is accepted explicitly**:
  - Remote web and mobile clients see only synced values, so a timestamp would have
    to live in the synced value. Flock's read interface does not expose row write
    times either.
  - Writing `changedAt` only on content changes would still need an on-demand RPC
    and client-side caching to refresh after expiry, which is out of proportion to
    the benefit.
  - The cost is that there is no upper bound on staleness. A remote UI may show
    stale advice for a long time. For example, the account or entitlement changed
    outside Lody, and that machine has had no probe or new session bringing back a
    declaration.
  - The cost is display-only. Dispatch uses only live evidence. After a turn runs,
    that session's live state decides whether a control is available. A
    `sourceVersion` change (adapter or runtime upgrade) invalidates the old
    declaration.
- Legacy sources (Codex legacy ids, Grok `_meta`) are **not** written to this row.
  They stay in the existing row and are derived at read time.

**No snapshot stabilization.** One idea was to leave `configOptions` unchanged when
a new session differs only in the current model, to cut whole-row rewrites. Real
probes of builtin Claude and Codex from four directories then showed every field
except `availableCommands` byte-identical, including every `currentValue`. The
rewrites come from project-level commands, now handled by
[project slash-command delta rows](../../implemented/architecture/2026-09-27-acp-command-scope-rows.md).

### 3. Shared resolution: per field, with "supported?" separate from "how to encode"

`packages/shared` has two entry points that share one set of control recognition
and binding rules:

- `resolveModelControls`: for UI, preflight, and hints. May use offline data.
- `projectDispatchControls`: for daemon dispatch (section 4). **No offline
  fallback**; it accepts only live evidence with proven provenance.

Signature of the display entry point:

```ts
type Evidence = 'declared' | 'legacy-derived' | 'snapshot' | 'live';
type Support<T> =
  | { state: 'supported'; value: T; evidence: Evidence }
  | { state: 'unsupported'; evidence: Evidence }
  | { state: 'unknown' };
type Binding =
  | { state: 'bound'; configId: string; encoding: 'boolean' | 'on-off-select' | 'select' }
  | { state: 'unbound' };            // known to be supported, but no way to send it to this agent

resolveModelControls(input: {
  snapshot?: AcpCapabilityCacheEntry;
  declaration?: AcpModelCapabilityDeclaration;
  /** Source version computed for the current agent config; a mismatching declaration is treated as absent. */
  expectedSourceVersion: string;
  /** Live runtime configOptions; when present, they take precedence over all offline data. */
  live?: { modelId: string; configOptions: AcpConfigOptionSummary[] };
  agent: { cliType; agentType };
  modelId: string | null;
}): {
  effort: { support: Support<string[]>; binding: Binding };
  fast: { support: Support<true>; binding: Binding };
};
```

- Support is decided per field, in this order:
  1. `live`, only when `modelId` equals the live model;
  2. `declared`, when `sourceVersion` matches;
  3. `legacy-derived`, for effort only;
  4. `snapshot`, only when `modelId` equals the snapshot model;
  5. otherwise `unknown`.

  One model can have fast declared while its effort comes from legacy data.
- Binding (config id and encoding):
  1. A live or snapshot option with the same semantics (via `isAcpFastModeConfigId` /
     `isAcpThoughtLevelConfigOption`). Its `type` gives the encoding: boolean, or a
     select with on/off values.
  2. Otherwise, for **known built-in adapters only**, a binding table (Codex
     `fast-mode`, Claude `fast`, plus the effort ids). Lody's `initialize` always
     declares support for boolean config options (`agent-client.ts`), so both
     adapters publish a boolean fast. The table records that encoding and is pinned
     by contract tests. Custom or overridden runtimes do not use the table.
  3. Otherwise `unbound`. The UI does not render the control, but the stored value
     is neither treated as invalid nor deleted.
- **Render cost constraint**: while the agent is streaming, session-doc merges rebuild
  composer inputs several times per second. `resolveModelControls` must memoize on
  the references of (snapshot, declaration, modelId, live list) and return the same
  object when inputs are unchanged; otherwise the selectors and the composer subtree
  rebuild every frame.

### 4. Per-turn projection, and who holds intent

The applier runs every turn, but it only iterates the keys present in this turn's
`inputConfig.configOptionValues` (`session-dispatch-watcher.ts`), and that table can
be sparse. Meanwhile, both the Claude and Codex adapters **retain** fast intent on
models that do not support fast. When the option reappears, its `currentValue` is
the retained value (Codex `createFastModeConfigOption(fastModeEnabled)` in
`FastModeConfig.ts`; Claude does the same). When Codex sends a prompt, it decides
speed from "retained toggle × whether the actual model supports fast". So omitting
fast does not mean turning fast off.

**Projection** computes the values actually sent this turn, **inside the daemon's
applier after the model switch**. The applier switches the model first. The
`setSessionConfigOption` response makes `AgentClient` replace its local state with
the target model's **live** `configOptions` (`applyConfigOptionsState`). So
projection is almost always based on live evidence, and offline declarations **take
no part in dispatch decisions**.

The evidence interface: a model switch, or the current state when there is no
switch, must produce a result with proven provenance. Reading the bare
`getConfigOptions()` array is not enough.

```ts
type LiveControlEvidence = {
  /** Only a complete list the agent itself sent counts: the configOptions in a set
   *  response, a config_option_update, or a session/new|load|resume response.
   *  Client-side optimistic values (retainLegacyConfigOptionValue) and empty
   *  acknowledgements do not count. */
  source: 'set-response' | 'config-option-update' | 'session-response';
  /** currentValue of the list's category:'model' option. */
  reportedModelId: string;
  configOptions: AcpConfigOptionSummary[];
  /** Monotonic; valid only if later than this turn's last model-set request. */
  generation: number;
};
```

"The control is missing from the list, so it is unsupported" may be inferred in
only two cases:

1. The model was switched this turn: only the synchronous complete response to
   **this** model-set request (`source: 'set-response'`) counts, and its
   `reportedModelId` must equal the target model.
2. The model was not switched this turn: use the **synchronously confirmed** session
   baseline. That is the most recent raw complete list that came from a synchronous
   response (session/new|load|resume or a set response) and whose `reportedModelId`
   equals the current model. Asynchronous notifications cannot become this baseline.

`config_option_update` is an asynchronous notification and carries no id of the set
request it answers; an old notification may arrive after a new request. So it may
update the display and may prove a control **exists**, but its absence cannot make
dispatch skip anything.

The following are all treated as unknown, so the value is sent as usual:

- empty acknowledgements;
- legacy `session/set_model`, which changes only `currentModel` and does not refresh
  the list;
- a reported model that differs from the requested one.

Also fixed: when the set response reports the actual model, `currentModel` is no
longer overwritten with the requested value.

Projection rules:

- The control is in the live list → send the requested value, **including `false`**.
- The control is definitely absent (per the rules above) → do not send it this turn;
  record it as "skipped".
- No evidence meets those conditions → send it, and let the agent confirm or reject.
- Semantic parameters (MCP `fastMode` / `reasoningEffort`) that cannot be bound to a
  config id → report "cannot project", and never claim the value was sent.

**Who holds intent**: intent is **derived from existing turn history**. That adds no
new storage and no new writes, and turn recording semantics do not change.

Why durable intent is needed instead of relying on adapter echo:

- An adapter can only echo values it has **received**. When a Role creates a session
  on a model without fast support, today the first turn never hands fast to the
  adapter at all. After switching to a supported model, the adapter echoes its own
  initial state, not the Role's value.
- Before sending a model switch, the agent has not yet reported the new model's
  state, so the toggle shows the default, which disagrees with the retained value
  that will actually apply.

**Turns keep recording the full table.** A turn's `inputConfig` means "the selection
**requested** this turn". It may include intent keys the current model does not
support, which were therefore not sent. A sparse table that records only explicit
settings was considered, but it would touch many readers and writers: new-session
local defaults, frozen Operations, CLI inheritance, the execute button, recent run
configs, Role creation, Schedule proposals, and history details. Rejected
(alternative J).

A new pure function, `resolveSessionControlIntent(history, queue, uptoUserTurnId)`,
belongs to the same family as `resolveSessionSafetyIntent` in section 6:

- It uses session-data directory reads and reads only up to the given turn.
- For effort and fast **separately**, it finds the most recent turn carrying that
  key. An explicit `false` is kept.
- For long conversations, it caches the last result per session, keyed by the
  history directory version, and processes only newly added turns.

History order is dispatch order, so "the latest request wins" holds naturally across
multiple clients and daemon restarts.

**Precedence for effort/fast is: user edit > history intent > runtime > default.**
Other keys keep today's order: edit > runtime > turn preference > default. Runtime
**must not** override durable intent, because runtime can be updated without this
turn's values having been applied:

- After a turn ends, the daemon still uses it as the target for late ACP
  notifications. A `config_option_update` received while idle is written as that
  turn's runtime patch, and `applyAcpRuntimeConfigPatch` only checks "is this the
  latest user turn".
- A notification may also arrive after the next turn has taken over.

In the UI, runtime is labeled "the state the agent last reported", because a late
notification may not reflect the current moment. It is used:

- to hint when it differs from intent, for example "the agent last reported off;
  the next send restores on". The hint offers "use the value the agent last
  reported", which makes that value the new intent with one click. This also covers
  users switching fast through the agent's own slash command: Lody keeps history
  intent but never overrides silently;
- for the "skipped / rejected" hints from projection.

**Local history import** (`local-project-history-sync-service.ts`) keeps **updating
runtime only** and does not write intent. Imported runtime comes from state that
`loadSession` rebuilds on a new connection, and it carries no provenance saying
the user chose it explicitly:

- Claude's fast comes from the SDK's state at the time, and effort may come from
  settings or defaults;
- Codex's history read path does not even return runtime;
- import only appends turns, so there is no existing write path when the source
  session changed only its config and added no messages.

Therefore:

- with no Lody history intent, runtime naturally becomes the displayed and sent
  value by precedence, and the first send from Lody writes it into a turn as intent;
- with existing Lody intent, the hint above shows the difference and the user
  decides whether to adopt it.

Consumers:

- **Daemon projection**: this turn's value is the one in its `inputConfig`; if
  absent, use `resolveSessionControlIntent(…, this turn)`. When live supports the
  control, send the intent value. The RPC is skipped **only** if the turn has a
  trusted synchronous confirmation (the same evidence rule as for absence: this
  model-set's synchronous complete response, or the synchronously confirmed session
  baseline) and that value already equals the intent.
  - A `currentValue` updated by an asynchronous notification can prove neither
    absence nor equality.
  - Conversely, any **contrary** asynchronous report received after the synchronous
    baseline invalidates that baseline's proof of equality for the control, and the
    intent value must be sent this turn. This is the same principle as section 6's
    "a contrary report invalidates a confirmation".
- **Native steer**: the `configPolicy: 'active'` comparison uses the same "this turn's
  value, else history intent". On a mismatch it keeps today's behavior: reject the
  steer and turn it into an ordinary queued turn, which goes through projection.
- **Composer**: two changes only:
  1. effort/fast history intent is an input, merged into the same value-stable
     preferences **before** unvalidated candidates and final selection. Candidates
     are never modified backwards after final selection.
  2. The authoritative branch **does not drop** effort/fast just because the current
     model has no visible selector. The key stays in the final table, marked "not
     supported by this model, skipped when sent".
- **Applying a Role and the session-creation entry points** (Chat Landing, Draft,
  applying a Role in an existing session, recent-run-config replay): Role values and
  local defaults are "user edit"-level inputs merged before final selection. Later
  filtering no longer drops invisible effort/fast keys. Gating sits at **every entry
  point that forms final dispatch values**.
- **CLI follow-up inheritance, Schedule proposals (display and creation), frozen
  Operations**: CLI/MCP turns may omit a key, so "the latest turn carries the full
  table" no longer holds. effort/fast are resolved per field with
  `resolveSessionControlIntent(…, the exact source turn)`. Frozen Operations write
  the resolved values into each target config **at acceptance**, and replay uses the
  frozen values without rereading parent history that may have changed.

**Mixed versions**: a new daemon declares `acpTurnControlProjection` in
`MachineMeta.protocolCapabilities`. Only when the target daemon declares it does the
UI keep invisible effort/fast keys and use history intent as the turn preference.
For old daemons it keeps today's behavior. The capability bit is written once at
registration and causes no ongoing sync.

**Sync volume**: no new writes. Only when the current model does not support
effort/fast but intent is kept do the queue and history `inputConfig` carry a few
extra keys.

Accompanying changes:

- **CLI inheritance**: an explicit model switch no longer drops inherited
  effort/fast keys; projection decides.
- **Recording "skipped" and runtime rejections**: skipped/rejected keys go into
  `SessionAcpRuntimeConfigSnapshot`, and the UI renders hints from there. The promise
  covers only "a best-effort hint for the latest turn":
  - the snapshot is one per session, and the next turn replaces it;
  - if the target is no longer the latest turn, the write returns `false` and nothing
    is written;
  - it is not a safety field, so it **does not block the prompt**;
  - the new fields must be added to the schema, the merge logic, and
    `acpRuntimeConfigEqual`;
  - write failures are logged at warn level.

  These fields must be **merged into the runtime patch the applier already
  returns** and written with it. A separate write would add one session-doc write
  and revision bump per turn.
- **Limits of the promise**: projection only covers the model the agent is on when
  the values are sent. The agent may switch models within a turn (for example,
  Claude falling back to another model after a refusal), and then a skipped value
  does not apply. Hint text may say only "skipped when sent this turn".
- **Runtime reconciliation**: after projection, read the agent's final reported
  `configOptions` and compare them item by item with the projection. Show a visible
  warning on any mismatch, including the ones currently suppressed for Claude/Codex.

State transitions that tests must pin:

- fast on (supported) → switch to unsupported (skipped) → intent changed to off →
  switch back to supported (`false` is sent and fast is actually off);
- a CLI follow-up that does not carry fast, after a load where the adapter defaults
  to off, with history intent on → the daemon sends on;
- a late `config_option_update` while idle reports fast off, with history intent on
  → the composer shows on (with a hint that the actual state differs), and the next
  turn sends on;
- during a steer, the agent's fast differs from history intent → the steer is
  rejected and becomes an ordinary turn, which projection fixes up;
- history imported from outside Lody brings fast off: with no Lody intent it is shown
  and sent as off; with an existing "on" intent a difference hint appears, and it
  becomes off only after "use the value the agent last reported";
- a late asynchronous notification changes `currentValue` to equal the intent →
  projection still sends the intent value and does not skip it;
- the synchronous baseline has fast on, the agent later reports off asynchronously,
  and on the next turn on the same model intent is still on → the baseline's proof of
  equality is invalidated and on is sent;
- on a model without fast support, the composer's full table still carries the
  intent key (new daemons), and projection skips it;
- a Role pins `fast=true` and creates a session on a model without fast support →
  switch to a supported model → fast takes the Role's value;
- two clients explicitly set different fast values in sequence → the newer one in
  history wins;
- after a daemon restart, intent is still recovered from history.

### 5. Consumers

| Consumer | supported | unsupported | unknown | unbound |
| --- | --- | --- | --- | --- |
| UI selectors (composer, mobile, Role and Schedule editors) | Render for the model | Hide; in Role/Schedule editors with a stored value, hint "not supported by the current model, skipped when sent" | Today's snapshot-based rendering | Do not render |
| Composer / session creation / Role application / recent-config replay | Validate the value; precedence "edit > history intent > runtime > default" | Keep the intent key (new daemons only) | Keep the intent key (new daemons only) | Keep the intent key (new daemons only) |
| CLI inheritance / Schedule proposals / frozen Operations | Resolve history intent per field up to the exact source turn; Operations freeze at acceptance | Same | Same | Same |
| "Is this Role applied" comparison (`composer-agent-roles.ts`) | Compare | **Ignore** the key; do not show the Role as unapplied because of it | Same as today | Ignore |
| Agent Role background reconciliation | — | **Do not delete** effort/fast keys | Do not delete | Do not delete |
| CLI / MCP preflight | Hint when the value is not in the declaration | Do not reject; hint | Do not reject | Semantic parameters: report "cannot project" |
| Daemon projection | See section 4; live only | | | |

- Composer changes are limited to the two in section 4 (effort/fast use history
  intent as an input with precedence over runtime; invisible keys are not dropped).
  Derivation for other keys, including runtime owning their key set, is unchanged.
  It stays a pure derivation and cannot reintroduce the React #185 effect
  oscillation. PR4 adds targeted regression tests for this area.
- An effort/fast mismatch in a Role or frozen Operation does not block execution; it
  only produces a hint. These are preferences, and an upgrade must not make a Role
  that used to run fail. Safety fields are different; see section 6.
- `reconcileAgentRoleSchema` changes so that model-dependent keys such as
  effort/fast are never deleted because of a snapshot. This changes the intent of the
  [Role reconciliation Spec](../../../../specs/agent-role-schema-reconciliation.md),
  which must be updated alongside it (it is currently a draft). A clarification in the
  same change: the Spec requires "the Role's pinned model matches the probe's model"
  before deleting, but the implementation treats a Role with no pinned model as
  matching. The two are aligned in that change. It also reduces sync: each deletion
  writes the Role row, bumps its revision, and uploads the catalog.
- CLI preflight rejects only type-level impossibilities (for example, a string for a
  boolean option). Everything else is a hint.

### 6. Safety first: pre-prompt check for permission and Plan (PR1, ships separately)

- The applier order becomes: model → ordinary options such as effort/fast →
  permission mode and Plan **last**.
- **This turn's effective safety intent**: turn configs are sparse, and
  `resolveSessionConversationConfig` only looks at the latest turn. So a new pure
  function `resolveSessionSafetyIntent(history, queue, currentUserTurnId)` resolves
  intent **per field, bounded to the executing turn**:
  - It reads only up to `currentUserTurnId`, never later. Existing source collection
    orders all queued items before history; without this bound, a later queued
    turn's safety intent could be applied to the current turn.
  - Permission mode and Plan are two independent fields (Core states explicitly that
    Plan is unrelated to permission). Each is found separately, from the most recent
    turn that explicitly carries it. `plan_mode` and the legacy `collaboration_mode`
    count as the same Plan field. An explicit `false` is kept: it means off, not
    unset.
  - It reads persisted history in the session doc, so it still holds after a process
    restart. It must use directory reads; see section 10.
  - Explicitly selecting a non-restrictive mode clears restrictive intent on the mode
    field only; turning Plan off clears only Plan. If neither field is found, there
    is no safety intent and nothing is checked.
- **Re-applying**: when this turn switches the model and the safety intent is
  inherited, the applier **re-sends** the inherited mode/Plan last, then checks it
  against the table below. If the new model does not support it, the set fails and
  the turn fails closed. That is the correct outcome.
- **Raw reports versus optimistic values**: only state the agent itself sent counts
  as evidence. Client-side fill-ins such as `retainLegacyConfigOptionValue`, and
  empty `set_config_option` responses, do not count.
- **Direction of evidence** (the same principle as dispatch in section 4:
  asynchronous notifications carry no request id and cannot be tied to a particular
  set):
  - **Positive confirmation**: a restrictive mode/Plan newly set this turn is
    confirmed only by the synchronous complete response to **this** set (the
    `configOptions` in the set response), or by a `session/set_mode` that was
    actually sent and returned successfully.
  - **Asynchronous notifications** (`current_mode_update`, `config_option_update`)
    can only **negate** a confirmation; they cannot create one on their own. For
    example, an old `plan` notification that arrives after a new request must not
    turn an empty acknowledgement, or an actual downgrade, into a success.
  - A state synchronously confirmed in an earlier turn and not re-set this turn can
    be inherited, but any later contrary report invalidates it.
  - `session/new`, and any report from before this turn's set, do not confirm this
    turn.
- Safety requirements are defined by the **request**, not by UI display
  classification. `classifyPermissionModeFace` only decides how a button looks; it
  is not a permission ordering.
  - A new **per-agent permission relation table** covers built-in agents only. For
    example, Claude: `plan` < `default` < `acceptEdits` < `bypassPermissions`. The
    Codex ordering is verified against the adapter during implementation. The table
    marks which modes are "restrictive" (read-only or Plan). A new built-in mode
    missing from the table counts as "not comparable", not as third-party.
  - The independent Plan option (Core `plan_mode` and the legacy
    `collaboration_mode`) is checked separately.
- Decision before the prompt. When both mode and Plan are present, each field must
  pass its own check. "Narrower per the table" applies to mode only. "Confirmation"
  in the table means only the positive confirmation defined above: this set's
  synchronous complete response, or a state synchronously confirmed in an earlier
  turn and not negated by a contrary report.

  | Effective safety intent | Evidence after setting | Result |
  | --- | --- | --- |
  | Restrictive mode or Plan on | Confirmation equals the request; for mode, narrower per the table also counts | Allow |
  | Restrictive mode or Plan on | Confirmation is another value, is not comparable, or a contrary report arrives later | **Fail closed** |
  | Restrictive mode | No synchronous response, but `session/set_mode` actually returned successfully | See below |
  | Restrictive mode or Plan on | `set_config_option` succeeded but returned an empty response | **Fail closed** |
  | Restrictive mode or Plan on | The set request failed | **Fail closed** |
  | Non-restrictive mode | Report is wider per the table | **Fail closed** |
  | Non-restrictive mode | Report is narrower, not comparable (third party), or absent | Allow, with a visible warning |
  | Non-restrictive mode | The set request failed | Allow, with a visible warning (same as today) |
  | None | — | No check |

- Handling "no post-set report, only a successful synchronous `set_mode`": the mode
  is now set **last**, and nothing else this turn changes it, so the successful
  acknowledgement confirms the latest request. The old staleness problem came from
  "set mode first, switch model after", which the new order removes. Therefore:
  - For verified versions of built-in adapters, accept the acknowledgement. For
    example, Codex's `setSessionMode` returns only `{}` and pushes no update.
  - For third-party agents, accept the acknowledgement and show a "no independent
    state report" hint. ACP defines `session/set_mode` as a setting operation and
    does not require the agent to notify afterwards; notifications are for changes
    the agent makes itself. This requires that Lody actually sent the RPC, received
    a successful return, and saw no contrary report afterwards.
- **Who defines "restrictive"**: only the built-in agents' permission table and
  Lody-defined Core `plan_mode` can mark a request restrictive. Third-party mode ids
  and descriptions carry no general read-only semantics. So even a third-party mode
  named `plan` is treated as non-restrictive and not comparable, and the product must
  not promise it is read-only.
- Failure messages state the requested value, the actual value, and the model. Role
  and Schedule failures point to where the config can be changed and re-run; they do
  not retry automatically with the same config.
- No one-time acceptance UX. When closing #333, record "one-time acceptance of wider
  permission" as a decision this series does not supersede and that remains open.

### 7. Rollout order

1. **PR1 safety first** (section 6). Before PR4 ships, rolling it back only restores
   the status quo. **After PR4 ships, PR1 cannot be rolled back on its own**; PR4
   must be rolled back first.
2. **PR2 readers and resolution**: register the new Flock row kind with tolerant
   parsing, and add `resolveModelControls` and the projection function with tests.
   No consumers yet, so no behavior change.
3. **PR3 producer**: the CLI parses `_meta.lody.modelCapabilities` v1 and writes the
   declaration row per section 2 (whole-value dedup, in-memory write-sequence
   guard). The refresh response keeps its shape. `ACP_CAPABILITY_CACHE_VERSION` is not
   bumped, because the existing row's format is unchanged. Field-level logging of
   capability-row writes already landed with the project command delta rows.
4. **PR4 consumer switch-over**: everything in sections 4 and 5, including:
   - daemon projection and history intent;
   - the `acpTurnControlProjection` capability;
   - the two composer changes and the session-creation entry points;
   - per-field resolution for CLI inheritance, Schedule proposals, and frozen
     Operations;
   - per-model UI rendering;
   - Role reconciliation and the "applied" comparison;
   - CLI, MCP, and the "skipped" fields in the runtime snapshot.

   It also:
   - deletes the Fable special case;
   - lets a present Codex declaration take precedence, keeping the hard-coded tiers
     only when there is no declaration;
   - updates the Role reconciliation Spec and the components constraint.
5. Follow-ups: Grok switches to publishing `modelCapabilities`. A declaration v2 can
   carry agent-level bindings and retire the host binding table. #333 is closed after
   this series merges, noting what supersedes it.

Rollback semantics:

- PR3 can be rolled back alone: the declaration row stops updating.
- PR4 can be rolled back alone, returning to **today's behavior, including today's
  defects**. Old daemons handle `inputConfig` with today's applier: it skips some
  Fable `fast=false` values and suppresses some warnings. Old Role reconciliation may
  again delete fast/effort, and old CLI preflight may again reject. None of this is
  worse than before PR4.
  PR4 does not change the shape of `inputConfig`; it may only carry effort/fast keys
  the current model does not support. Old daemons send them as usual, and agent
  rejections are handled as today (warned or suppressed). So queued, undispatched
  turns do not need draining.
- When the UI does not see the `acpTurnControlProjection` capability (including after
  a daemon downgrade), it automatically falls back to today's filtering.
- Ordering constraint: after PR4 ships, rolling back PR1 requires rolling back PR4
  first.

### 8. Specs and constraints

- PR1 drafts `specs/acp-run-config-safety.md` (draft): the pre-prompt check rules
  for permission and Plan.
- PR2 drafts `specs/acp-model-controls.md` (draft) covering:
  - the three concepts;
  - intent and projection;
  - "offline data never rejects effort/fast and never deletes stored values";
  - "undeclared means unknown".
- PR4 updates `specs/agent-role-schema-reconciliation.md` (stays draft).
- `packages/shared/AGENTS.md` and `packages/components/src/lib/AGENTS.md` each get a
  one-line constraint linking to the Specs.
  Both files are near the 8 KiB gate (about 66 and 28 bytes left). Before adding the
  constraint, move an existing topic out per
  [where content goes](../../../README.md#where-content-goes).

### 9. Highest implementation risk and how to verify it

The highest risk is **deciding evidence provenance between `AgentClient` and the
applier**: which message proves what (positive confirmation or negation), and when
absence may justify a skip. That decision determines both whether the safety check
wrongly allows a turn and whether projection wrongly skips a value.

Verification, following the repository's test rules (explicit signals,
deterministic fixtures, no real timing):

- **Deterministic contract tests at the ACP message boundary**: use a fake ACP
  connection to control message order, and deliver an old `plan` notification or
  control notification **after** a new set response. Assert that:
  - restrictive requests are not allowed as a result;
  - fast is not skipped because a notification lacks it;
  - empty acknowledgements, legacy `set_model`, and a reported model that differs
    from the request all resolve to unknown;
  - a restrictive request that gets only an empty `set_config_option` response fails
    closed;
  - a restrictive state confirmed in an earlier turn is invalidated by a contrary
    notification.
- **State transition tests**: every transition listed in section 4.
- **Sync tests**:
  - the same declaration arriving again causes no Flock write;
  - the "skipped" fields cause no extra runtime-snapshot write;
  - Role reconciliation no longer writes the Role row because of effort/fast.
- **End-to-end tests against pinned real adapters** (following #333's
  `acp-runtime-contract.e2e` approach): run the current submodule versions of the
  Claude / Codex adapters through these flows and check the actual state before the
  prompt:
  - a model switch;
  - Claude downgrading the mode on a model switch;
  - Codex returning an empty `set_mode` acknowledgement;
  - the shape and boolean encoding of both adapters' `modelCapabilities`
    declarations, and how each echoes retained values when an option reappears.

  These need accounts and will most likely run only locally; CI relies mainly on
  contract tests with synthetic fixtures.
- All of the above is planned verification; none has run at the proposal stage.

### 10. Cost

The runtime and sync numbers below come from one development machine's daemon logs
for 2026-09-25 to 27 and from `lody machine list --include-acp-capabilities`. They
are a sample, not representative of all users.

**Runtime**

- Applying a run config today: Codex p50 18ms / p90 92ms, Claude p50 65ms / p90
  161ms, about 6 RPCs per application (96 applications). 84 of the 96 already
  carried the fast key.
- Projection and the safety check are in-memory computations. Two kinds of RPC may
  be added, each about 3–10ms:
  - re-sending the mode when this turn switched the model and the safety intent is
    inherited;
  - sending effort or fast when history intent differs from the live value and this
    turn did not carry the key.

  The RPC is skipped only when a synchronously confirmed value already equals the
  intent, so most turns still send effort/fast, as today. The total number of RPCs
  is expected to stay the same as today, possibly slightly higher (not measured).

  RPCs do not write Flock themselves, but after a send, the agent's
  `config_option_update` may trigger an extra session runtime patch and a revision
  bump. That is **the one sync cost to watch during implementation**: PR4 records
  runtime-patch write counts and bytes per turn to verify it.
- `resolveSessionSafetyIntent` must use session-data **directory reads** (which
  include input config, exclude bodies, and cache parsing), never `readAll` /
  `readSessionHistory`, or long conversations would materialize every body.

**Sync** (every change to a Flock row's value is synced to every client in the
workspace)

- The existing capability row is written whole: Claude / Codex 4–40 KB (mostly
  `availableCommands`), Devin 177 KB. The sample workspace's 10 machines total about
  700 KB of capability rows.
- Probes are frequent in the sample. On 09-25 each agent saw about 124–149 refresh
  requests, and 207 whole-row writes actually happened (writes occur only when
  content differs). On 09-26 there were 84 such writes, and on 09-27 there were 30.
  Real probes show these writes came from `availableCommands` changing with the
  working directory, not from snapshot model flips; that is now handled by
  [project slash-command delta rows](../../implemented/architecture/2026-09-27-acp-command-scope-rows.md).
- Sync impact of this proposal:
  - New declaration row: about 1 KB each, no timestamps in the value, zero writes
    when content is unchanged. First publication and content changes (new models,
    entitlement changes, adapter upgrades) sync to **all existing clients**; a new
    client pays the full amount on first sync. About 20 rows (about 20 KB) in the
    sample workspace. The write-sequence guard lives only in memory.
  - Role reconciliation no longer deletes effort/fast, which cuts Role row writes,
    revision bumps, and catalog uploads.
  - The "skipped" keys in the runtime snapshot are merged into the existing patch,
    adding only a few dozen bytes.
  - Intent is derived from existing turn history: no new writes. Only when a model
    does not support effort/fast but intent is kept do the queue and history carry a
    few extra keys.
  - The `acpTurnControlProjection` capability bit is written once at registration.
  - No snapshot stabilization: measurement found no writes to save.

**Engineering effort** (estimated from #333's per-file diff)

| PR | Production code | Tests |
| --- | --- | --- |
| PR1 safety first | ~400–600 | ~600–900 (incl. e2e) |
| PR2 readers and resolution | ~200 | ~250 |
| PR3 producer | ~100 | ~150 |
| PR4 consumers | ~500–800 | ~600–900 |

About 2.8–3.8k lines in total, versus +4854 for #333. The main cuts relative to the
first version: no time-based TTL or timestamps in the value, and intent derived from
existing history with no new storage. PR1 remains the riskiest part and cannot be
dropped.

## Alternatives

- **A. Keep the status quo and add more special cases** (Fable, Codex tiers): every
  new model needs a code change, and the snapshot-flipping problem remains. Rejected.
- **B. Store full `configOptions` for every model**: generic, but it requires one of
  two things:
  - probing each model in turn, which is slow and triggers account-side behavior;
  - adapters publishing every descriptor, so the Flock row grows with models ×
    options and syncs to every client.

  Revisit through declaration v2 once a non-safety control other than effort/fast
  really varies by model.
- **C. Rely on the runtime only**: the UI cannot show the right controls before
  sending. Rejected.
- **D. Add a `modelControls` field to the existing capability row** (this proposal's
  first draft): old writers overwrite the whole row, and the field collides with the
  strict RPC schema. Replaced by a separate row (raised in Codex review).
- **E. Send `fast=false` when unsupported, with no intent/projection split**:
  adapters usually do not expose the option when the model does not support it, so
  sending it gets rejected (the Fable special case patches exactly this), and it
  overwrites the user's intent. Rejected.
- **F. Merge #333 as a whole**: most complete, but it couples the safety fix with
  catalog reading, which makes review and rollback expensive.
- **G. Rely on adapter echo plus an in-memory daemon table of pending re-sends** (a
  version from the cost-cutting pass): an adapter can only echo values it has
  received, so a Role's intent filtered out on the first turn is lost for good. The
  in-memory table also needs extra override rules and is lost on restart. Replaced by
  deriving intent from existing turn history, which likewise adds no writes and is
  naturally ordered and durable.
- **H. Put timestamps in the declaration value for a time-based TTL**: remote clients
  see only synced values, so the timestamp must live in the synced value, and every
  confirmation becomes a write. Replaced by accepting no time bound (remote display
  may stay stale for a long time; display only), with the write-sequence guard in
  memory.
- **I. Snapshot stabilization**: the decision boundary is unclear, and measured
  `configOptions` never changed across directories, so there is nothing to save.
  Rejected.
- **J. Record only explicit effort/fast settings in turns (sparse recording)**: it
  makes "a key carried by a turn" mean exactly "explicit intent". But it requires
  changing new-session local defaults, frozen Operations, CLI inheritance, the execute
  button, recent run configs, Role creation, Schedule proposals, and history details.
  Recording the full "requested this turn" table and giving effort/fast history intent
  precedence over runtime touches far less. Rejected.

## Review status

The proposal went through fourteen rounds of cross-review with Codex, with every
point checked against the code. The final verdict is "approve".

- The first seven rounds established the backbone: a separate declaration row,
  separate display and dispatch entry points, the evidence-provenance rules, and the
  safety check first.
- A cost analysis then made sync volume a first-class constraint, and rounds 8–14
  converged on the current version:
  - no time-based TTL or timestamps in the value, with the write-sequence guard in
    memory;
  - effort/fast intent derived from existing turn history, with precedence over
    runtime;
  - projection skips sends or infers absence only from synchronous confirmation;
  - snapshot stabilization rejected after measurement.

This was a review between agents and is not human approval: maintainer review is
still required before implementation, and the related Specs are drafted as drafts.

## Evidence

- Code reading (`main` 2e0886b8): `packages/shared/src/ai.ts`,
  `apps/cli/src/agent/acp-capability-normalization.ts`,
  `apps/cli/src/session/session-execution-service.ts`, `apps/cli/src/lib/loro/doc.ts`,
  `apps/cli/src/commands/session.ts`, `apps/cli/src/session/acp-session-config-applier.ts`,
  `packages/components/src/components/shared/acp-selector-options.ts`,
  `packages/components/src/lib/acp-session-config-selection.ts`,
  `packages/components/src/lib/agent-role-schema-reconciliation.ts`,
  `packages/shared/src/message-schemas.ts`, `packages/shared/src/machine-flock.ts`,
  `packages/acp-extension-claude/src/acp-agent.ts`,
  `packages/acp-extension-codex/src/CodexAcpServer.ts`,
  `packages/acp-extension-codex/src/FastModeConfig.ts`.
- PR #333's description and comments. The proposal was revised over several rounds
  of cross-review with Codex.
- No tests or runtime verification have been run.
