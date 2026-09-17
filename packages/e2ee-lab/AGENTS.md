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
- Binding contracts: [lab spec](../../specs/e2ee-adversarial-lab.zh.md).
