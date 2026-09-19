# Bundling Sorbet as a Lody builtin agent

Status: proposed
Translation: current

[中文](2026-09-17-bundled-sorbet-runtime.zh.md)

## Abstract

Lody can integrate Sorbet without a machine-wide Sorbet host because Sorbet already implements ACP
session persistence and the Lody extensions needed for turn-boundary fork, steering, goals,
compaction, subagents, history, and usage. The proposal is to pin Sorbet source into the Lody release,
build a bundled `sorbet-acp` entry, and start one worker for each live Lody Session while keeping
Lody's transcript, collaboration, identity, and recovery contracts authoritative. The remaining work
is concentrated in cross-process state ownership, trusted credential setup, platform sandbox
packaging, and crash/idempotency tests. Sorbet must not be offered as production-ready until these
gates pass; a partial integration must not remove or silently weaken existing Lody capabilities.

## Decision context

This proposal records the working decisions and prototype status from the Lody-Sorbet integration
investigation. It does not declare the runtime production-ready and is not an approved Spec.

- Sorbet is shipped in the Lody installer as a bundled builtin. Users do not download or update a
  separate Sorbet release.
- Lody owns the pinned Sorbet revision, packaging, update, rollback, process supervision, and product
  behavior. Sorbet owns its agent runtime and execution semantics.
- Each live Lody Session owns one Sorbet ACP worker. There is no machine-wide long-lived Sorbet host.
- Recovery never retries an external effect whose delivery is uncertain. Such an effect is surfaced
  as `unknown` and requires explicit recovery or a fresh user action.
- The integration cannot trade away user-visible Lody behavior. Capability gating may represent a
  fact that Sorbet or a Provider has no such capability; it must not conceal a regression introduced
  by the integration.
- A fresh Sorbet configuration contains no custom Provider. Valid Codex OAuth is the preferred
  default. Claude OAuth is disabled by default and requires an explicit enable action before it can
  be selected. Users can explicitly switch between enabled OAuth connections and custom Providers.
- Selecting a connection sets the default for new Sessions. A running or resumed Session remains
  pinned to its recorded connection and model until the user explicitly changes it; Provider
  failures never trigger a silent cross-Provider retry.

Investigation baselines:

- Lody: `fb249326d555623208a5a281383df445839d660e`.
- Sorbet: `a7dee4dffb746164aeea6dfda50a88e98ac169a7`.
- Sorbet ACP compatibility and conformance were tested after building the required workspace
  packages: 5 files and 36 tests passed. The generated compatibility matrix test also passed.

Prototype integration pin: Sorbet `875da2768db0b3b5aa82bf69e1b80ad89f925571`. This revision also
contains the cross-process Journal writer lease and credential mutation lease described below, and
passes the packaged Windows SRT helper path explicitly into sandbox readiness checks.

## Prototype implementation status

The first user-facing integration slice now works in the Lody checkout. It is available for manual
testing but does not by itself satisfy the production gates below:

- Lody pins Sorbet as a submodule and excludes its independent pnpm workspace from Lody's workspace.
  The CLI preparation step verifies the exact revision before building Sorbet's dependency closure.
- Vite and the development bundler emit `sorbet/dist/stdio-cli.js` and the adjacent
  `filesystem-worker.js`. The release build copies sandbox-runtime's Linux and Windows helpers and
  writes the ESM package boundary expected by the worker. Sorbet's CLI entry registers Pi's bundled
  OAuth loaders through static imports so every OAuth implementation is included in the standalone
  bundle rather than left as an unresolved runtime import.
- Builtin launch resolution starts the bundled entry with `process.execPath`, pins its capability
  cache identity to the bundled revision, uses `<lody-data>/agents/sorbet`, and rejects a standalone
  Node runtime below Sorbet's `22.19.0` floor without changing the Node floor for other Lody agents.
- Lody resolves the target Machine's environment or system HTTP(S) proxy before starting the worker.
  Sorbet's executable composition installs a proxy-aware global dispatcher, so Pi's native `fetch`
  uses that route for OAuth exchange, refresh, and Provider requests while preserving `NO_PROXY`.
- Sorbet is a known builtin for validation, title policy, and protocol-driven ACP authentication and
  appears in the Agent picker. Its Agent form contains a Machine-scoped Provider Center gated by the
  versioned `sorbetProviderCenter` protocol capability.
- The Provider Center recommends Codex OAuth, requires an explicit action before enabling Claude
  OAuth, supports custom Provider create/edit/delete and per-Provider logout, and changes the default
  only for new Sessions. API keys use a one-time encrypted Machine RPC and are written through
  Sorbet's credential boundary without entering Loro or Agent configuration.
- Lody's dedicated authentication client advertises a versioned credential-form extension backed by
  the same one-time encrypted Machine RPC. Sorbet preserves ACP's default ban on credential forms
  for other clients, marks Pi `secret` and `manual_code` prompts as secret only for this extension,
  and serializes browser URL consent before the fallback form so the two interactions cannot race.
- A release-build smoke check launches the exact bundled entry from an empty data root, negotiates
  ACP, verifies Codex and Anthropic OAuth advertisement, starts Codex OAuth, and cancels after Pi's
  credential-safe manual-code prompt. This exercises the OAuth module and Lody authentication
  extension in the final bundle instead of only checking metadata. The check also calls
  `providers/list` and verifies that `session/new` reports `auth_required` instead of guessing a
  Provider. On a prepared sandbox host, it then configures a synthetic local OpenAI Responses
  Provider through the bundled control entry and drives the final ACP bundle through dynamic
  thinking and permission configuration, parallel model-requested Read Tools, a model-requested Bash
  Tool, durable load/replay and resume after worker `SIGKILL`, and fork-at-turn/list/delete. The
  filesystem worker and sandbox helper are therefore exercised rather than only checked for
  presence. This is deterministic Darwin evidence, not packaged Windows/Linux helper validation.
- Packaged Electron workers keep `ELECTRON_RUN_AS_NODE` only for Sorbet's trusted internal
  filesystem process while the sandbox credential filter continues to hide other Host variables.
  Lody also passes the emitted filesystem worker's absolute path explicitly because Vite may move
  Sorbet's importing module into a shared chunk whose relative path is unrelated to the worker.
- Sorbet's deterministic proxy regression sends global `fetch` through a local CONNECT proxy via
  `ALL_PROXY`, then proves that `NO_PROXY` bypasses the same proxy. It does not contact a live
  Provider.

## Proposed runtime topology

```text
Lody Machine
  Lody CLI / supervisor
    Lody Session A  ---- stdio ACP ----  Sorbet worker A
    Lody Session B  ---- stdio ACP ----  Sorbet worker B
    Lody Session C  ---- stdio ACP ----  Sorbet worker C

  Lody data root
    Loro session and collaboration state
    agents/sorbet/
      sessions/<sorbet-session-id>/...   exclusive writer per session
      artifacts/...
      credentials/configuration          serialized machine-scoped mutations
```

`Session.createAgent` already gives Lody the correct process lifetime: a Session starts an ACP
process and chooses new, load, resume, or fork. Sorbet's durable session store makes a fork source
available to the new target process, so a separate daemon does not add a required capability.

The Sorbet data directory must be derived from Lody's `getLodyDataDir()` contract, for example
`<lody-data>/agents/sorbet`, and passed explicitly. It must respect `LODY_DATA_DIR` and installation
profiles rather than use Sorbet's default `~/.sorbet` path. The directory is machine-global so a new
worker can resume or fork an existing Sorbet Session; per-worker data roots would break that
property.

## State and authority

| Concern                                                | Authority                                          | Required integration behavior                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product transcript, collaboration, UI state            | Lody/Loro                                          | ACP replay must reconcile by stable identities and never duplicate already materialized messages.                                                                    |
| Execution evidence and Sorbet resume                   | Sorbet Journal                                     | Preserve append-before-apply evidence and recover interrupted effects as `unknown` when non-delivery is not proven.                                                  |
| Live process ownership                                 | Lody Session supervisor; Sorbet JSONL writer lease | Lody avoids duplicate starts; Sorbet rejects a second writer at the Journal boundary, and Lody maps busy ownership into explicit recovery or orphan-worker handling. |
| Provider credentials and Provider configuration        | Lody Machine / execution host                      | Keep secrets machine-scoped, serialize mutations, and refresh workers at safe turn boundaries.                                                                       |
| Requester authorization, attribution, and Git identity | Frozen Lody user identity for the turn             | Do not infer user identity from the machine-scoped Provider credential.                                                                                              |
| Title                                                  | Lody                                               | Register Sorbet title ownership as `none`; Sorbet currently publishes a first-prompt-derived title, so Lody should keep its isolated title generation.               |
| Runtime version                                        | Lody release                                       | Capability cache identity includes the pinned Sorbet revision/protocol version and changes on Lody update or rollback.                                               |

Sorbet's `JsonlJournalStore` now acquires a Store-owned writer lease keyed by the canonical Journal
path before scan, tail repair, or append, and holds it until the file handles close. A second process
receives `JournalWriterBusyError`; `SIGKILL` releases the OS lock immediately, so a replacement does
not wait for a stale timeout. Lody no longer needs to implement the Journal correctness lock. It
should avoid redundant starts and distinguish an active worker, an orphan to handle, and an invalid
attachment when it presents the busy error.

This requirement is not inherited from Pi. Sorbet defines its own Journal, fact schemas,
append-before-apply barriers, integrity chain, and recovery projections while using Pi libraries for
model and Tool interfaces. Native Pi also appends directly to one JSONL session file without a
per-session file lock. The current Pi integration keeps the normal path single-writer through Lody's
OS-backed one-host-per-installation-profile lease, the process-local `SessionManager` maps and create
deduplication, and serialized turn dispatch; its ACP session id is the native Pi file path reopened by
a replacement connection. That is a topology invariant rather than a lock keyed by the native file,
so two distinct Lody Session records pointing at the same Pi file would still be unsafe. Sorbet now
enforces the missing mutex at its own JSONL boundary. Hardening Pi can be handled independently and
is no longer a prerequisite for the Sorbet integration.

The shared files need a different policy. Sorbet's `JsonCredentialStore` now reloads reads from disk
and holds a cross-process SQLite lease across reload, OAuth refresh, and atomic replacement, so live
workers do not lose credential updates. Lody serializes all bundled custom Provider mutations through
one Machine control queue, and per-Session workers load definitions at process start; running and
resumed Sessions stay pinned instead of observing a mid-Session Provider rewrite. Direct external
writers are outside this integration contract. Approval-reviewer settings still need equivalent
coordination before Lody exposes that control.

## Provider product behavior

Provider setup belongs to the execution Machine, exposed through a dedicated Sorbet configuration
surface in Lody. It is an account, connection, and model control center rather than an Agent-config
form. It owns:

- Codex OAuth login and status, presented as the recommended default connection;
- an explicit enable action before Claude OAuth login or selection;
- trusted API-key entry that sends the secret directly to the target Machine and never places it in
  ACP elicitation, Loro state, prompts, Journals, retained progress, or logs;
- custom Provider definitions, endpoints, model catalogs, non-secret connection status, and
  per-Provider logout;
- the Machine's default Sorbet connection.

Agent configuration may record a portable connection preference, model, reasoning level, and other
execution options. A Session records the resolved connection and model actually used. The
resolution order for a new Session is an explicit Agent/Session selection, then the Machine default,
then a valid Codex OAuth connection. Claude OAuth is never selected implicitly. With no usable
selection, Lody opens configuration instead of guessing.

Changing the Machine default affects only new Sessions. Resume uses the connection already recorded
for that Session. If it is unavailable, the Session becomes blocked and asks the user to choose a
replacement; Lody does not fail over during a turn. An explicit replacement is persisted as a
Session configuration change before later work uses it.

OAuth continues through Sorbet's ACP authentication methods and Lody's existing URL/elicitation
client. API keys cannot use generic ACP form elicitation because that channel excludes credentials.
The Provider Center therefore requires a trusted Machine RPC that accepts encrypted secret input,
writes through Sorbet's credential boundary, and returns metadata only. Standard ACP
`agent.logout` currently clears every credential in Sorbet, so per-Provider logout also belongs to
this Machine control plane rather than that global method.

## Existing protocol fit

Sorbet already supports the ACP behavior needed by Lody for:

- new, load, resume, close, delete, list, fork, prompt, cancel, models, modes, and config options;
- durable transcript and Plan replay;
- permission requests, structured elicitation, filesystem tools, terminal tools, direct MCP
  composition, images, and embedded resources;
- standard usage plus detailed Lody usage;
- Lody turn ids and fork-at-turn;
- active-turn steering with exact acknowledgement;
- Lody goals, compaction activity, and subagent lifecycle/list/cancel/output;
- durable recovery of interrupted model requests, approvals, and external effects.

The unsupported compatibility rows do not all represent missing Lody product features:

- Lody's scheduled and cross-session tasks are host-owned. Sorbet's missing native `tasks`
  extension does not disable those tasks, and Sorbet separately exposes child subagents.
- Lody supplies MCP configurations directly, so standard MCP-over-ACP transport is not required for
  the current integration.
- Sorbet projects compaction through the Lody extension, so missing standard ACP v2 compaction
  updates are not a blocker for the current Lody client.
- Sorbet has no native command catalog. Existing Lody skills remain host-owned; if Sorbet later adds
  native slash commands, it must also publish `available_commands_update` before those commands are
  presented as supported.
- Provider rate-limit windows are still absent. If a bundled Sorbet Provider can expose quota data,
  the Lody `rateLimits` extension is a production gate for that Provider. Lody must not synthesize
  quota data when the Provider has none.

Sorbet publishes dynamic model, thinking-level, and permission-mode options. Lody already accepts
config updates, but the integration must verify a model switch whose thinking-level ladder differs
from the initially selected model; the initial capability probe alone is not enough evidence.

## Packaging and launch

The preferred source relationship is an exact Sorbet revision pinned by Lody, using the same kind of
reviewable source pin Lody uses for ACP adapters. Sorbet's current packages are private workspace
packages at version `0.0.0`, so treating them as a separately released npm runtime would add a release
contract that does not exist today.

Lody should add a bundled `sorbet-acp` CLI entry and launch it with `process.execPath`, alongside its
other sibling adapter entries. The build must include Sorbet's workspace dependency order and the
`filesystem-worker` artifact; running the ACP package tests from a fresh checkout before building its
workspace dependencies fails because the package exports point at `dist`.

`@anthropic-ai/sandbox-runtime` is a runtime dependency, not only TypeScript source. Its package
contains Linux x64/arm64 seccomp helpers and Windows x64/arm64 executables; Linux also requires
system `bubblewrap` and has kernel/user-namespace constraints. Lody's Electron staging currently
copies only an explicit runtime package chain, so Sorbet and its required helpers must be added to
that staging contract and verified for every shipped platform and architecture. Sandbox readiness
must fail before a Session is offered, with an actionable error; silently falling back to a weaker
sandbox would violate the no-feature-loss rule.

The Electron lock currently resolves 39.5.1, whose embedded Node is 22.22.0 and satisfies Sorbet's
Node `>=22.19.0` requirement. The standalone Lody CLI still declares Node
`>=22.14.0 <23 || >=23.6.0`. The prototype keeps that contract for existing agents and rejects only
Sorbet launch below Node 22.19. Before the builtin is released, packaging and UI readiness must
preserve that actionable, Sorbet-specific failure.

The public Electron package must also keep its product name aligned with the local installation
profile (`Lody OSS`). Electron can resolve and cache `userData` while imported main-process modules
are initializing, before a later `app.setName()` call runs. Using the production name (`Lody`) in
package metadata therefore makes the OSS build share the production app's user-data directory and
single-instance lock, so it exits when both are installed. The package identity is now covered by a
regression test so side-by-side testing keeps separate state and process ownership.

Sorbet authentication can use Lody's dedicated ACP authentication client for OAuth and URL flows.
Sorbet intentionally refuses to carry API keys through generic ACP form elicitation. API-key setup
therefore needs a trusted Lody credential UI/port or controlled environment import that writes the
machine-scoped credential store without placing secrets in session journals, prompts, or Loro state.

## Implementation sequence

1. Pin Sorbet source in Lody, build `sorbet-acp` and its filesystem worker as sibling CLI entries,
   stage sandbox-runtime helpers, and prove the packaged entry starts with the Lody-owned data root.
2. Register Sorbet as a builtin whose authentication remains protocol-driven, then exercise ACP
   initialize plus new/load/resume/close through the existing one-worker-per-Session lifecycle.
3. Validate turn history, permissions, model/config changes, steering, goals, compaction, subagents,
   usage, fork-at-turn, and crash recovery before exposing the builtin outside development.
4. The Machine-scoped Sorbet Provider Center, trusted API-key RPC, per-Provider logout, custom
   Provider control queue, new-worker selection replay, and the selection rules above are now
   implemented for manual testing.
5. Complete the cross-platform package, sandbox, fault-injection, upgrade, and rollback gates before
   marking Sorbet production-ready.

## Production gates

The builtin should remain unavailable to production users until all of these gates pass:

1. A package smoke test launches the exact packaged `sorbet-acp` entry on every shipped OS and
   architecture, including its filesystem worker and sandbox helpers.
2. The packaged Sorbet writer lease excludes a second worker on every shipped platform and releases
   immediately after `SIGKILL`; Lody presents `JournalWriterBusyError` correctly and never steals a
   live owner automatically.
3. Credential, custom Provider, and reviewer-setting mutations are serialized across workers and
   become visible to already-running workers at defined safe boundaries.
4. New, load, resume, close, delete, and fork-at-turn round trips preserve stable message and turn
   identities without duplicate Loro history.
5. Fault injection covers crashes before and after effect request, effect execution, effect terminal
   commit, Lody history flush, and turn-pointer update. Only proven non-delivery may be retried;
   uncertain effects remain `unknown`.
6. Steering acknowledgement, goals, compaction, subagent lifecycle/output, permissions, Plan review,
   filesystem/terminal tools, MCP, model changes, thinking levels, images, usage, and turn diffs pass
   end-to-end through Lody's real UI and persistence path.
7. OAuth logout/login and trusted API-key setup work without exposing credentials, and quota data is
   shown for Providers where Sorbet can obtain it.
8. Desktop and standalone CLI runtime floors, packaged sandbox prerequisites, upgrades, downgrades,
   and rollback to the previous Lody-bundled Sorbet revision are exercised.

## Alternatives considered

A machine-wide long-lived Sorbet host would centralize credentials and catalogs, but it introduces a
new daemon lifecycle and a shared failure domain while Lody already owns per-Session process
supervision. It is unnecessary once shared-file coordination is made explicit.

A separately downloaded Sorbet release would reuse Lody's managed-runtime machinery, but it would
give users two version and rollback surfaces and would require Sorbet to publish a platform runtime
contract. The selected product direction is to bundle the pinned runtime with Lody instead.

Giving every worker a private Sorbet data directory would avoid shared-file races, but load, resume,
and fork across replacement processes would require unsafe state copying or a new replication
protocol. A shared machine root with per-Session exclusive ownership preserves Sorbet's current
durability model with a smaller boundary.

## Evidence and limits

- Sorbet's ACP compatibility test passed at the recorded baseline.
- After `pnpm --filter @sorbetai/acp... build`, all Sorbet ACP tests passed: 5 files, 36 tests.
- Sorbet now implements the Store-owned Journal writer lease. Same-process exclusion, real
  two-process exclusion, owner close, and immediate recovery after `SIGKILL` are covered; all 14
  Runtime test files and 187 tests pass.
- Sorbet's credential store now reloads committed state and serializes mutations across processes;
  the process-local attachment registry, custom Provider store, and reviewer settings still require
  the ownership work identified above.
- Sorbet's full NodeAgent suite passes 11 files and 94 tests at the prototype pin, including the
  packaged Windows SRT helper profile regression test and the Electron Node-mode worker regression.
- On Darwin arm64 with Node 24.14.0, the complete Lody CLI release build passed and produced a 23 MB
  Sorbet runtime tree. The exact bundled entry passed ACP initialize, OAuth advertisement, execution
  through the first Codex login-method prompt, `providers/list`, empty-store `auth_required`, custom
  Provider control, model-driven parallel Read and Bash execution, dynamic Session configuration,
  worker-crash load/replay and resume, and fork-at-turn/list/delete checks. Provider Center component
  tests cover Machine capability gating, direct Claude enablement, custom-model deduplication, and
  keeping API keys on the dedicated secret RPC. The repository-wide `pnpm check` also passed,
  including the full shared, components, CLI, Electron, i18n, and source-boundary suites.
- Electron's published 39.5.1 runtime reports Node 22.22.0. A Darwin arm64 installer was built with
  the bundled-runtime smoke check, ad-hoc signed for local testing, and launched alongside the
  production Lody app. The installed `Lody OSS` process used its own user-data directory and
  single-instance lock while the production process remained live.
- On Darwin arm64, the Electron 39 Helper running in Node mode passed Sorbet's native SRT boundary
  test against the exact bundled filesystem worker: protected reads stayed denied and Workspace
  reads/writes completed. The CLI-bundle lifecycle smoke additionally exercises model-driven Read and
  Bash Tools and replacement-worker recovery. No real Provider login, paid model request,
  model-driven Tool execution through the installed UI, Lody-integration external side effect, or
  packaged Windows/Linux launch was exercised. Runtime-level `SIGKILL` and two-worker contention are
  verified; their packaged behavior remains a release gate.

## Implementation entry points

- [Builtin agent and title policy](../../../../packages/shared/src/ai.ts)
- [Builtin launch resolution](../../../../apps/cli/src/agent/setting.ts)
- [Lody Session process lifecycle](../../../../apps/cli/src/session/session.ts)
- [Lody installation data root](../../../../packages/shared/src/node/installation-profile.ts)
- [Electron CLI runtime staging](../../../../apps/electron/scripts/cli-native-deps.mjs)
- [Sorbet ACP entry](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/acp/src/stdio-cli.ts)
- [Sorbet Lody extension advertisement](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/acp/src/agent.ts)
- [Sorbet compatibility matrix](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/acp/COMPATIBILITY.md)
- [Sorbet NodeAgent composition](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/node-agent/src/agent.ts)
- [Sorbet session registry](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/node-agent/src/sessions/registry.ts)
- [Sorbet JSONL Journal](https://github.com/LodyAI/Sorbet/blob/875da2768db0b3b5aa82bf69e1b80ad89f925571/packages/runtime/src/journal/jsonl-store.ts)
- [Current Pi adapter lifecycle](../../../../packages/acp-extension-pi/README.md)
- [Current Pi native-file resume](../../../../packages/acp-extension-pi/src/connection.ts)
