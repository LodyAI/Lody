# E2EE adversarial lab

Local deterministic collaboration plus one attack Agent. Not product E2EE.

## Required source style

- **Effect 4.0.2**: use the `e2eeEffect` catalog; do not change the default
  v3 catalog or pass Effect objects between majors.
- `pure/`: deterministic values or typed `Result`; no I/O, ambient state,
  clocks, randomness, logging or input mutation. Only unobservable local scratch
  mutation is allowed.
- `workflows/`: `Effect<A, E, R>` descriptions declare Services for storage, network, crypto, entropy,
  clocks, environment and process. No eager execution, hidden Live defaults or
  internal runtime starts. Convert pure Results with `Effect.fromResult`.
- `platform/`: thin Service implementations/Layers; direct external API access
  belongs here or in composition. Concentrate complexity in pure first, workflows
  second; keep domain policy/state transitions out of platform.
- No expected `throw`: pure returns typed `Result`; workflows use typed Effect
  failures. Only unexpected fatal defects may throw. Never disguise defects or
  interruption as ordinary failure or Pending.
- Use Effect logging/tracing and injected Services, never `console` or ambient
  loggers. Platform/composition configures sinks; pure returns diagnostic data.
  Never log secrets.
- Required migration target, not completed purity: existing bridges remain
  explicit, temporary exceptions, not permission to add more.

## Lab invariants

- Real `@lody/e2ee-core`, streams-crdt, Loro/Flock, and official sqlite Riverrun.
  Do not stub cryptography or invent a second sync protocol.
- Honest clients, scheduling, and judging are ordinary programs. Only the
  attacker uses an Agent, and only at recorded event boundaries.
- Attackers cannot read honest private keys, plaintext, recovery material,
  private replay bundles, or judge expectations.
- Replay compares events, labeled entropy, and protocol frames. Private device
  material is test-only and never part of the attacker view.
- Observation/mutation settles at the current boundary before automatic honest
  permits; advancing actions own explicit permits. Only finish measurements drain.
  `finish` seals the public handle; private replay services live until runtime disposal.
- Attackers use `createAttackLab` only. That handle does not expose honest
  client directories, epoch keys, or judge expected plaintext. The one exception
  is an excluded insider: from its removal/revoke on, `insiderRead` uses the keys
  that party retained, never another client's.
- Content sealed after an exclusion is registered as protected before the write.
  An insider opening it is `violation`, or `outside-model` if a control/keys
  `forkView` withheld records. Every report property row is measured or
  `unavailable`; never infer a pass from a missing row.
- Writers must not save an `appendWriteOnly` result as a read cursor: keep the
  last read offset and merge the batch version into the lower bound.
- `finish` composes integrity/durability from measured client facts and claims;
  guest-authored content under a malicious Riverrun is `outside-model`, not a
  silent pass. Agent claims without matching facts do not invent violations.
- Honest host is a thin gateway in front of sqlite Riverrun. Re-read the
  verified ledger for membership, `deviceMayWriteDocument`, and `canSendEpoch`.
  Do not put Org RBAC in Riverrun. Unbound or claimed-genesis tokens are not
  membership. Ordinary HTTP has no Riverrun URL, failpoints, or clock header.
  Harness clock/failpoints use `host.setNow`/`setFailpoint` or
  `/v1/harness/*` with a test-only token. Malicious-server tests use
  `riverrunUrl` on the LabBackend handle, not `/readyz`. CLI `--test` enables
  the harness; default CLI does not. This is not OS isolation.
  Decision: [host gateway](../../.agents/notes/implemented/architecture/2026-09-18-e2ee-host-gateway.md).
- Host forwards only allowlisted headers to Riverrun (no lifecycle headers, no
  bearer token). Control appends use the host's verified tail as CAS offset and
  fail on a partial read. Key appends pass `assertEpochStreamAppend`. Join
  requests are signature-checked, never replaced by another signer, and bind a
  pending userId to its first account. Credentials need a single-use challenge.
  Harness clock/failpoints apply only in test mode. Snapshot offsets must be
  within the stream tail; a non-current idempotent retry is not republished.
- Content signing keys come from the session's verified ledger
  (`contentAuthorKey`), never from header claims; writers use ledger `userId` and
  membership as author fields. Sealing checks the key against the commitment.
- Content seal uses the authenticated ledger epoch, not `max(local keys)`.
  Honest writers refuse to seal while `rotationRequired` (`maySealNewContent`);
  tests that revoke/remove then write must `publishEpoch` first.
- `DemoSession.genesis` is the signed record, NOT the Org hash. Key commitments,
  history and envelope AAD use `ledger.state.genesis`; only replay/bootstrap uses
  the record. Never silently recompute commitments in old captured artifacts.
- Lab I/O goes through Effect `LabClock` / `LabFs` / `LabHttp`
  (`src/services/`): AttackLab, attacks, persist, session, host, content-session,
  and restricted-agent LLM fetch. Promise owners use `LabRun` with a persistent Scope; await disposal.
  `services/run.ts` owns runtime starts; Live boundaries provide `LiveLabLayer`. Crash `spawn` and CLI entrypoints still use Node process APIs.
  Effect is not a sandbox; isolation is the capability handle.
- Independent packs (`e2ee-lab-repro/v1`) bind dirty-tree identity; private
  material is mode 0700 and is not the attacker view. Auto-advance is oldest
  runnable FIFO; identity schedule replay is for explicit concurrent choice.
  Nested streams-crdt request order is an uncovered microtask boundary.
- Binding contracts: [lab spec](../../specs/e2ee-adversarial-lab.zh.md).
