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
- Lab I/O goes through Effect `LabClock` / `LabFs` / `LabHttp`
  (`src/services/`): AttackLab, attacks, persist, session, host, content-session,
  and restricted-agent LLM fetch. Promise/Live defaults provide `LiveLabLayer`
  adapters. Crash `spawn` and CLI entrypoints still use Node process APIs.
  Effect is not a sandbox; isolation is the capability handle.
- Binding contracts: [lab spec](../../specs/e2ee-adversarial-lab.zh.md).
