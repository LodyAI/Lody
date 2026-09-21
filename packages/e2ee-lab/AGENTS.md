# E2EE adversarial lab

Local deterministic collaboration plus one attack Agent. Not product E2EE.

- Real `@lody/e2ee-core`, streams-crdt, Loro/Flock, and official sqlite Riverrun.
  Do not stub cryptography or invent a second sync protocol.
- Honest clients, scheduling, and judging are ordinary programs. Only the
  attacker uses an Agent, and only at recorded event boundaries.
- Attackers cannot read honest private keys, plaintext, recovery material,
  private replay bundles, or judge expectations.
- Replay compares events, labeled entropy, and protocol frames. Private device
  material is test-only and never part of the attacker view.
- Attackers use `createAttackLab` only. That handle does not expose honest
  client directories, epoch keys, or judge expected plaintext.
- `finish` composes integrity/durability from measured client facts and claims;
  guest-authored content under a malicious Riverrun is `outside-model`, not a
  silent pass. Agent claims without matching facts do not invent violations.
- Honest host is a thin gateway in front of sqlite Riverrun. Re-read the
  verified ledger for membership, `deviceMayWriteDocument`, and `canSendEpoch`.
  Do not put Org RBAC in Riverrun. Unbound or claimed-genesis tokens are not
  membership. Malicious-server tests use `riverrunUrl` to bypass the gateway.
  Decision: [host gateway](../../.agents/notes/implemented/architecture/2026-09-18-e2ee-host-gateway.md).
- Content seal uses the authenticated ledger epoch, not `max(local keys)`.
- Lab I/O goes through Effect `LabClock` / `LabFs` / `LabHttp`
  (`src/services/`): AttackLab, attacks, persist, session, host, content-session,
  and restricted-agent LLM fetch. Promise/Live defaults provide `LiveLabLayer`
  adapters. Crash `spawn` and CLI entrypoints still use Node process APIs.
  Effect is not a sandbox; isolation is the capability handle.
- Independent packs (`e2ee-lab-repro/v1`) bind dirty-tree identity; private
  material is mode 0700 and is not the attacker view. Auto-advance is oldest
  runnable FIFO; identity schedule replay is for explicit concurrent choice.
  Nested streams-crdt request order is an uncovered microtask boundary.
- Binding contracts: [lab spec](../../specs/e2ee-adversarial-lab.zh.md).
