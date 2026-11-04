# Open E2EE contracts and integration work

Status: proposed
Translation: current

[中文](2026-10-15-e2ee-open-contracts.zh.md)

## Abstract

Current public consumers do not complete every whitepaper behavior or establish
production E2EE. Keep unresolved decisions in their existing draft Specs, without
repeating proposed fields in per-PR Notes. Missing integration is tracked separately
from decisions requiring human approval. The [current decision record](../../implemented/architecture/2026-10-15-e2ee-current-decisions.md)
does not approve any item below.

## Decisions requiring review

| Owner                                                                              | Open boundary                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Atomic removal](../../../../specs/e2ee/atomic-removal.md)                         | Tag8 encoding and stage-before-CAS direction are selected. The revised Spec remains draft for review; no old-client capability or downgrade reader is required.                                                                                                                                                                            |
| [Recovery vault](../../../../specs/e2ee/recovery-vault.md)                         | Vault-v1 wrapping, immutable upload/index CAS, retention and resumable recovery are selected and implemented; the revised Spec remains draft for approval. Valid old ciphertext does not prove latest state.                                                                                                                               |
| [Publisher recoverability](../../../../specs/e2ee/publisher-key-recoverability.md) | The former backup A/B alternatives are superseded by whole-group staging before CAS. A committed group is recoverable without the publisher disk; a noncompliant manager can still withhold keys. Vault and management-identity recovery remain separate.                                                                                  |
| Snapshot and checkpoint trust                                                      | The selected content-v0 snapshot field authenticates continuation position and has a durable original-admission reference; inviter-pinned snapshot qualification/joining is selected and implemented; other production current-checkpoint sourcing remains separate. Existing update binding or SQL caches do not supply those guarantees. |
| Other product/protocol scope                                                       | Installed-history product activation, signed comparison notes and strict deadline B remain separate. Replay now reexecutes captured original inputs without a core entropy hook; secure first sealing and ordinary tolerance are unchanged.                                                                                                |

## Integration still unfinished

After [loro-streams#421](https://github.com/loro-dev/loro-streams/pull/421) is released,
upgrade Lab's SQLite dependency and remove `patches/@loro-dev__sqlite-riverrun@0.3.0.patch`.
The temporary patch modifies the published dist artifact; it is not a permanent fork.

The [manifest](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/.agents/docs/e2ee-migration-manifest.json) owns detailed disposition.
Remaining work is production freshness/qualification sourcing, authorized retained-history access, machine execution and other product consumers, actual OS-keychain/platform acceptance and product assembly. The desktop main protector is implemented but not enabled. Current creation/host recovery, staged publication, model-driven finite action plans and original-input replay are implemented, with missing measurements explicitly unavailable.
The tutorial has a Spec but no migrated application source. These gaps are not all
new protocol decisions; implement settled work without inventing the unresolved parts.

No pending option is selected here. Notes, source inventories, synthetic tests or
an ancestor's READY/CI cannot grant human approval or production acceptance.
