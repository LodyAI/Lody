# E2EE shared-member derived work

Status: proposed
Translation: current

[中文](2026-10-31-e2ee-shared-member-derivation.zh.md)

## Abstract

On an encrypted machine, a shared member's turn can drive MCP work: child Sessions, chat,
Roles, continuations and agent control. The machine signs those derived inputs, so they
look like the owner's own and used to bypass sharing and project checks. #2149 therefore
failed closed. The owner decided on 2026-10-31 to restore this capability, reusing the
signed-original chain instead of adding a new token. A derived input now records its
origin inside the signed row, and on the same machine it starts only with the origin
member's rights. Cross-machine derivation is still undecided, so it fails closed. No real
backend or device run has been made.

## Decision

The owner settled these points on 2026-10-31, relayed by the E2EE coordinator.

- **Proof.** A derived input carries `derivedFrom: { sessionId, userTurnId }` in its
  history row. The signed-original check covers that field, like `scheduleRun`, so editing
  or removing it afterwards makes the original unverifiable.
  - Only this machine may author such an input.
  - When it starts, the machine verifies the origin row itself. The origin must be a
    shared member's own signed Turn, not derived, not scheduled and not authored by the
    machine.
- **Authority.** The derived input is authorized as the origin member: the member's
  current rights, the owner's sharing policy and every project the input reaches. The
  existing known-revocation and <15-minute freshness gate applies.
- **Lifetime.**
  - A derivation is created only while the origin turn is active. The daemon checks the
    live runtime and then the signed origin when the input is written.
  - It must start no later than 15 minutes after the origin's signed deadline.
- **Depth and count.**
  - One level. A derived turn exposes no invocation identity and cannot steer.
  - At most 20 derived inputs per origin turn, matching the largest single Agent batch
    (20 targets).
- **Cross-machine.** A member derivation that targets another machine is refused when it
  is written (`e2ee_derivation_cross_machine_unsupported`). The extension point is
  `decideEncryptedDerivation`.
- **Agent control.** iOS control from a member turn requires that member's rights for the
  turn's projects. Preview attribution stays owner-only.
- **Owner work.** Unchanged. It has no `derivedFrom` and keeps owner authority, including
  operation recovery after its turn ended.

## Alternatives

- *A delegation token pre-signed by the member's client.* Rejected by the owner. It is a
  new wire format and needs desktop, Web and mobile changes.
- *An origin taken from `author` or another unsigned field.* Rejected. A member could edit
  it without breaking the signature check.
- *Threading a flag through the MCP and Operation layers.* Rejected. Any layer that
  dropped it would silently yield owner authority. Classification happens where the row is
  written instead.

## Consequences and limits

- The derivation count is in-memory per origin turn and per claim owner. A daemon restart
  ends the origin turn anyway, and the start deadline bounds any recovery.
- The RPC dispatch fast path never verifies this machine's own inputs, because only the
  signed row can carry `derivedFrom`.
- Cross-machine derivation, hosted backend checks and real-device behavior are unverified.
- Related: [machine sharing](2026-10-28-e2ee-machine-sharing.md); [#2149](https://github.com/LodyAI/Lody/pull/2149).
