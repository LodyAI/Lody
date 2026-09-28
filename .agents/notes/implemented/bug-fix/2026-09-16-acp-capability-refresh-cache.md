# Stop re-probing ACP capabilities on every reconnect

Status: implemented
Translation: current

[中文](2026-09-16-acp-capability-refresh-cache.zh.md)

## Abstract

On an idle machine, `machine/acp-capabilities-refresh` started and killed a real ACP agent
process roughly 1,700 times a day — six configs every five minutes, 0.8–7.1 s each — and every
one of those probes recomputed the capability entry that was already stored under an unchanged
`capabilitySourceVersion`. Two independent defects produced it: the machine had no cache-hit path
at all, and the renderer's "one startup pass" gate was a boolean that any abort reset, so each
presence reconnect re-probed every agent config. The machine now answers from the persisted entry
when the entry came from a real probe, its source version is exactly what the current launch
inputs would produce, the machine itself recorded — in memory only, never in the synced document —
that the entry came from the current launch inputs including the environment, and it was confirmed
within 24 hours; an unchanged confirmation renews it once it is past half that age, so a stable
entry does not expire into a permanent miss. Startup discovery now records completion
per config, so restarting an interrupted pass re-probes nothing that already answered. Explicit
probes — Settings refresh, post-authentication verification, onboarding's provider test, provider
setup — set a new `force` flag, negotiated through `MachineMeta.protocolCapabilities` because a
daemon that predates the flag parses the request strictly and drops it. The residual uncertainty is
named below: why the renderer's boolean never latched could not be established from the machine's
logs, so the fix was chosen to hold under either candidate mechanism rather than to depend on
knowing.

## What the logs actually showed

Measured from `~/.lody/logs/2026-09-16.log.1` (02:11–10:29, one machine, three workspaces) and
the rotated `2026-09-16.log.gz`:

- 755 refresh requests, 764 `[acp-startup] creating ACP client`, 793 `Starting ACP client`.
  Bucketed by hour, ACP client creations sat at a flat 72/hour — exactly six configs every five
  minutes, i.e. the steady state consisted of nothing but capability refreshes.
- 104 of 126 request batches contained exactly six requests, each batch spanning 14–23 s, with
  inter-batch gaps pinned at 300–302 s.
- Every batch requested the same six configs in the same order: claude, pi-acp, opencode, grok,
  kimi, deepseek.

Decoding the machine's own Flock document (`~/.lody/loro-repo/<workspaceId>/repo.sqlite3`,
`flock_docs`, the `:mf:<machineId>` row, read with `@loro-dev/flock-wasm`) identified the producer
without instrumenting the app:

- The machine has exactly six live `agentConfig` rows, and sorting their ids gives precisely the
  observed request order. That is `Object.values(getMachineFlockAgentConfigs(...))` — the full
  config list walked by `runStartupAcpCapabilitiesRefresh`.
- `acpCapability` rows carried identical `sourceVersion` values across every cycle (for example
  `builtin-claude-acp:0.70.0+agent-sdk:0.3.258+claude-code:2.1.258`) with `fetchedAt` advancing to
  the latest pass. Every probe was recomputing an answer it already had.

## Which trigger it was, and which it was not

The task named two candidates. The agent-role reconciliation hook
(`use-agent-role-schema-reconciliation.ts`) is excluded by its own probe set: the workspace's
seven owned roles reference four distinct configs — claude, codex, deepseek, grok — so it can
neither produce the observed `pi-acp`/`opencode`/`kimi` requests nor omit `codex`. It does explain
the sporadic off-cadence bursts that do contain `codex`, which the machine-side cache now answers
without a process.

The recurring cycle is `runStartupAcpCapabilitiesRefresh`, driven by the presence transport
leaving and re-entering `synced` every 300 s (the machine's own room logs the same lease:
`Loro presence room status: reconnecting` → `joined`, 227 times). Two structural facts turn one
startup pass into a standing cycle:

- `scheduleAfterStartupNavigationCooldown` computes `max(0, lastNavigationAt + cooldown - now)`.
  On an app nobody is navigating, `lastNavigationAt` is long past, so the 30 s cooldown is 0 ms and
  a reconnect starts a pass immediately — matching batches that begin within a second of the lease
  boundary.
- `startupAcpCapabilitiesRefreshCompleted` is only set when a pass reaches its end un-aborted, and
  the non-`synced` branch of the presence subscription aborts the in-flight pass while `.finally`
  reschedules it. Nothing recorded which configs had already answered, so every restart was a
  full re-probe.

**Named limit:** the machine's logs cannot show *why* that boolean never latched across eight
hours. Both remaining explanations require presence to leave `synced` while a ~20 s pass is in
flight — either the renderer's lease boundary emits more than one transition, or its post-refresh
`resyncMachineFlockRows(requireRemoteSync: true)` outlives the window (the machine did log
`Streams sync failed: internal_error` with retries for `reason=acp-capability-update` during every
batch). Distinguishing them needs renderer instrumentation, and the local composition has no
hosted presence room to reproduce against. The fix therefore does not depend on the answer: with
per-config completion recorded in a runtime-scoped set, a re-armed pass is a no-op regardless of
how often it re-arms or why the boolean is false.

## Machine-side cache

`refreshMachineAcpCapabilitiesForConfig` consults the persisted entry before the existing
in-flight dedupe. A hit requires all of: a resolvable expected source version, an exact
`sourceVersion` match at the current `cacheVersion`, `provenance: 'runtime'`, a launch-input
record showing this process wrote the entry from the current inputs (see below), and an age within
`ACP_CAPABILITY_REFRESH_CACHE_TTL_MS`. `decideAcpCapabilityRefreshCache` in `@lody/shared` owns
that decision and names each miss reason, which the machine logs.

Resolving "the version a probe would stamp" is the non-obvious part. The stored version is the one
the *launcher* produced, and for managed builtins that includes the installed runtime version
(`builtin-kimi:0.36.0`), which `getAcpCapabilitySourceVersion(input)` alone cannot reproduce.
`resolveExpectedAcpCapabilitySourceVersion` therefore reads `getRuntimeStatus()` — local, no
download, no spawn — and returns `undefined` when the runtime is not installed, because
substituting the bundled target version would let a cached entry outlive an install that never
happened. It also mirrors `resolveManagedRuntimeForLaunch` by enqueueing the update coordinator on
`updateAvailable`: that enqueue was previously reached only through launches, and idle capability
refreshes were in practice the thing discovering managed-runtime updates.

Rebasing onto main brought a new managed builtin, `pi`, and the exhaustive override map failed to
compile until it was considered — the purpose of declaring it exhaustively. Pi has no replacement
binary; its override is an extension list, which the launcher answers by calling
`ensureCurrentRuntime` (installing the target version first) instead of using what is installed.
The resolver therefore returns `undefined` for Pi with extensions whenever the installed version is
not the target, since that is not the runtime a probe would start.

## Renewing an unchanged entry (review correction)

Review caught that the first revision could not keep its own promise. `MachineDocument.
updateAcpCapabilities` compares the new entry with the stored one while ignoring `fetchedAt` and
returns the stored entry untouched when they match. That skip predates this change and was
harmless while nothing read `fetchedAt`; once the TTL did, an entry whose content never changes —
the common case — expired once and was then re-probed by every later unforced request, forever,
because each probe produced identical content and so never moved `fetchedAt`. It also falsified
this note's own claim that created sessions refresh the entry "for free": an unchanged session
report was skipped in exactly the same way.

The skip exists for a real reason: without it every probe and every created session costs a Flock
write, a flush and a Machine Flock sync. The writer now keeps skipping unchanged content while the
stored entry is younger than `ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS` and rewrites it — only to
move `fetchedAt` — once it is older.

Half the TTL is chosen because it is the value that yields both guarantees that matter. Writes are
bounded: an unchanged entry is rewritten at most once per config per 12 hours however often
sessions start or refreshes are forced. And the free-refresh claim becomes true: an agent that
starts at least one session per 12 hours has its entry renewed before it can expire, so it never
needs a probe at all. A threshold equal to the TTL would bound writes the same way but let an
entry used every 20 hours still lapse; a smaller one only adds writes. Probes after expiry always
renew, since an expired entry is by definition past half its lifetime.

### Why the TTL is 24 hours

The source version already covers every input Lody controls, so the TTL only bounds drift Lody
cannot observe: slash commands, sub-agents, or model entitlements a user changes in the agent's own
configuration. Two paths converge faster than any TTL — `scheduleCreatedSessionCapabilityUpdate`
confirms the entry from every real session's `session/new` response (renewing it once it is past
half its lifetime, see below — the first revision claimed this without it being true), so agents
people actually use are refreshed without a probe, and Settings offers an explicit forced refresh. What the TTL is left to
cover is agents nobody launches, where a shorter value buys little: an hour would cost ~144
probes/day on this machine, a day costs ~6, and both are far below the measured ~1,700. A
future-dated `fetchedAt` counts as fresh rather than as a reason to re-probe, because writer and
reader stamp it from the same server clock, so a negative age means a clock adjustment.

## Environment edits, and why the record lives only in memory (review correction)

The first revision also claimed that override, env and custom-command changes always miss. The env
half was wrong. `serializeCustomAcpLaunchSpec` is `command` plus `args`; a registry version is
`id@version`; among builtins only DeepSeek digests one environment value, its base URL. Yet
`fetchAcpCapabilities` merges the config environment into the spawned agent, and a token, endpoint
or account switch can change the models and options it advertises. An edited environment therefore
kept matching the stored `sourceVersion` and was answered with stale capabilities for up to a day.

The hard constraint is where an environment identity may be stored. Capability entries live in the
Machine Flock document, which syncs to the cloud, and `apps/cli/AGENTS.md` already forbids putting
an API key or a derivative of it into a cache key: a digest of a low-entropy token is recoverable by
enumeration, which the review rules class as a secret leak.

Chosen: the answering daemon keeps, per config, a SHA-256 fingerprint of everything the probe was
launched with — the same serialization the in-flight dedupe already keys on, environment included —
in a process-memory map. It is set whenever this process writes or confirms an entry, by a probe or
by a created session, and a cache hit requires it to equal the fingerprint of the current inputs.
Nothing new is persisted, synced or logged. The hash exists only so the long-lived map does not hold
another plaintext copy of the environment.

The cost is explicit: after a daemon restart the map is empty, so each config probes once before
the cache is trusted again. That is a handful of probes per daemon lifetime — about what the
startup pass did before this change anyway — against the ~1,700 per day measured.

Alternatives, both rejected:

- **A revision or update timestamp on the `agentConfig` row that joins the hit decision.** The row
  has no such field; adding one is a schema change every writer must adopt, and an edit from an
  older renderer or CLI would not bump it, so the cache would stay stale exactly in mixed-version
  operation.
- **Invalidating the capability entry when the config is edited.** Also writer-dependent — every
  edit path in every client version must remember to do it — and a missed path fails silently in
  the stale direction.

The in-memory record compares the inputs the daemon is about to launch with, so it is correct no
matter which client, in which version, made the edit. It also covers every launch input, so it
subsumes rather than duplicates the DeepSeek endpoint digest.

## `force` has to be negotiated, and omission is the mechanism

The first revision of this change sent `force: true` unconditionally, which review caught. Both
transports parse the request with a strict schema, so a daemon built before the field exists does
not ignore it:

- **Machine RPC:** `LoroStreamsRpcRequestSchema.safeParse` fails in `handleRawRequest`, which logs
  a warning and **returns without appending any response**. The caller sees no error, only the
  client backstop timeout — strictly worse than a rejection.
- **Local control:** `LocalSessionControlRequestSchema` is a discriminated union over the same
  strict `MachineAcpCapabilitiesRefreshRequestSchema`, so the daemon answers HTTP 400
  `invalid_request`. This path matters as much as the remote one, because the desktop app and the
  CLI daemon are upgraded separately and either can be the newer side.

Verified against the pre-change files at `4de83a57`: both schemas were `.strict()` and neither
declared `force`. Verified in zod 4.3.6 that `.strict()` rejects an unrecognized key **even when
its value is `undefined`** — which is why `negotiatedAcpCapabilitiesRefreshForce` returns `{}` to
spread rather than `{ force: undefined }`. A "falsy force" spelling would have shipped the same
bug in a form that reads as fixed.

The capability is `acpCapabilityRefreshCache` at version 1, declared in
`machine-protocol-capabilities.ts` alongside its version and its check, as
`packages/shared/AGENTS.md` requires. One key covers both facts on purpose: a daemon that never
caches is exactly a daemon that rejects `force`, so splitting them could only produce an
unrepresentable state. Degradation is a no-op for every caller — such a daemon always probes,
which is what a forced caller wanted, and an unforced caller gets the pre-change behavior.

Negotiation happens at exactly two places, and the distinction is which requests cross a version
boundary:

- `create-workspace-runtime.ts`'s `requestMachineAcpCapabilitiesRefresh`, the single choke point
  both planes flow through, so the renderer's callers keep passing plain `force: true`.
- `apps/cli/src/commands/agent-config.ts`, where the CLI binary can be newer than the daemon it
  dispatches to.

The CLI's in-process callers — post-authentication verification in `session-execution-service.ts`
and `provider-setup-manager.ts` — are deliberately **not** negotiated: the message never leaves the
build that created it, so a capability check there would only be able to disagree with itself.

## Every caller, and whether it forces

| Caller | Forces | Why |
| --- | --- | --- |
| `create-workspace-runtime.ts` startup pass | no | wants the cache; this is the cost being removed |
| `use-agent-role-schema-reconciliation.ts` | no | reconciles against the current entry, whatever produced it |
| `machine-agent-settings.tsx` Settings refresh | yes | a person changed something outside the launch inputs |
| `providers-screen.tsx` onboarding provider test | yes | exists to prove the agent starts |
| `commands/agent-config.ts` `refresh-capabilities` | yes | same intent as Settings; was missed in the first revision |
| `session-execution-service.ts` post-authentication | yes | new credentials change entitlements |
| `provider-setup-manager.ts` verification | yes | proves the runtime it just installed starts |

That is the complete set of request construction sites; the sweep is reproducible with
`grep -rn "'machine/acp-capabilities-refresh'"` filtered to request literals.

## Builtin agents cannot use the static table

`STATIC_BUILTIN_ACP_CAPABILITIES` was evaluated for item 4 and deliberately not used. Its own
contract says so — "deliberately not a probe mode: machine capability refreshes should start the
real ACP runtime" — and the data backs that up: it carries no `availableCommands`, no
`sessionFork`, no `acknowledgedSteer`, and no `goalActions`, it returns `undefined` whenever a
runtime override is present, and its model lists are Lody-authored constants rather than what the
installed runtime and the user's account actually offer (`kimi` and `deepseek` ship empty model
lists). Serving it from a refresh would publish `provenance` other than `'runtime'` and silently
downgrade session capabilities. Caching a real probe's result gets the same process saving without
inventing data, which is why this note takes that route instead.

## Alternatives considered

- **A minimum interval between reconnect-triggered passes.** Rejected: it is a heuristic floor
  that hides the actual defect, and the root `AGENTS.md` prefers explicit contracts over hidden
  fallbacks. Recording per-config completion states the intended contract directly.
- **Keying the cache on `cacheVersion` and age only.** Rejected: a runtime override or a changed
  `DEEPSEEK_HARNESS_BASE_URL` would then be answered from an entry describing a different binary.
- **Making the machine ignore repeat requests within a window instead of answering them.**
  Rejected: callers legitimately need the current entry (role reconciliation does), and refusing
  to answer would turn a cheap read into an error path.

## Verification and limits

Behavior is covered by the tests listed in [the Spec](../../../../specs/acp-capability-refresh-cache.md);
the machine-side tests assert that no probe is started, not that a mock was called a certain number
of times, and since the review corrections they run over a real `MachineDocument` on an in-memory
Flock so the skip/renew/overwrite decisions are the production ones. Both corrections were ablated:
disabling renewal fails the writer threshold test and the "expired, re-probed identical, then
served from cache" test; treating launch inputs as always matching fails the environment-edit and
restart tests. The persisted-rows test checks for each token, for its SHA-256, and for the SHA-256
of its `KEY=value` pair, down to the 12-hex-character prefix length this codebase stores elsewhere. The negotiation tests validate the payload a client actually emits against a
previous-generation schema **derived from the current one** (`.omit({ force: true })`), so the
reconstruction cannot drift away from what shipped, on both transports.

Not verified: the end-to-end effect on a running desktop build, because reproducing the 300 s
presence lease requires the hosted presence room. Also not under test: that the
`refresh-capabilities` command's own call site passes `force` — driving that Commander action would
need `getAuthContextOrThrow`, `withWorkspaceManager`, `listMachineMetasForWorkspace` and
`dispatchLocalControl` all replaced, and the resulting assertions would be about those mocks rather
than about behavior. What it spreads is covered where it is real, in the negotiation tests. The expected steady-state effect on the
measured machine is six probes per day instead of ~1,700, but that is a projection from the cache
predicate, not a measurement.

Related: [ACP capability cache compatibility](../../../../specs/acp-capability-cache-compatibility.md)
governs how a *reader* tolerates entries from other versions; this note and its Spec govern when a
machine may answer a refresh from one.
