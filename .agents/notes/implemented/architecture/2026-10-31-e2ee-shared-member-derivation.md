# E2EE shared-member derived work

Status: implemented
Translation: current

[中文](2026-10-31-e2ee-shared-member-derivation.zh.md)

## Abstract

On an encrypted machine, a shared member's turn can drive MCP work: child Sessions, chat,
Roles, continuations and agent control. The machine signs those derived inputs, so they
look like the owner's own and used to bypass sharing and project checks. #2149 therefore
failed closed. The owner decided on 2026-10-31 to restore this capability, reusing the
signed-original chain instead of adding a new token. A derived input now records its
origin inside the signed row, and on the same machine it starts only with the origin
member's rights. Shared-member cross-machine derivation is still undecided, so it fails closed. No real
backend or device run has been made.

## Decision

The owner settled these points on 2026-10-31, relayed by the E2EE coordinator.

- **Proof.** A derived input carries `derivedFrom: { sessionId, userTurnId }` in its
  history row. The signed-original check covers that field, like `scheduleRun`, so editing
  or removing it afterwards makes the original unverifiable.
  - Only this machine may author such an input.
  - When it starts, the machine verifies the origin row itself. The origin must be a
    human's own signed root Turn, not derived, not scheduled and not authored by the
    machine.
- **Authority.** The derived input is authorized as the origin member: the member's
  current rights, the owner's sharing policy and every project the input reaches. The
  existing known-revocation and <15-minute freshness gate applies.
- **Lifetime.**
  - A derivation is created only while the driving turn is active. The daemon checks the
    live runtime and then the signed origin when the input is written.
  - Since the owner decision of 2026-11-10 no start deadline applies; only the active-turn
    and per-origin limits do. The machine signs the derived input, `derivedFrom` included, in
    the same commit ([signed execution intents](../../implemented/architecture/2026-11-10-e2ee-signed-execution-intent.md)).
- **Depth and count.**
  - Multiple hops inherit the same root directly. Claimed descendants expose the root
    requester for further delegation and agent control; intermediate machine signatures
    never replace human authority.
  - Shared-member descendants share at most 20 durable starts per human root, matching
    the largest single Agent batch (20 targets). Write reservations happen after root
    and target authorization, once per target machine/input ID; retries reuse their slot.
    Rejected targets consume none. Owner starts do not spend this quota.
- **Cross-machine.** The owner decided on 2026-10-31 that the first version does not
  derive across machines. A member derivation that targets another machine is refused when
  it is written (`e2ee_derivation_cross_machine_unsupported`). The extension point is
  `decideEncryptedDerivation`.
- **Agent control.** iOS control from a member turn requires that member's rights for the
  turn's projects. Preview attribution stays owner-only.
- **Owner work.** Human-signed same-machine delegation retains its root and rechecks the signer,
  remains unbounded and may steer a running turn. Verified principal and provenance
  travel separately so a root reference never silently disables Owner steering.
  Cross-machine Owner delegation rechecks the root at the sender, then uses the existing
  machine-signed path without local-only `derivedFrom`; the target verifies that machine
  signature and its current local authorization. A received machine-signed Owner input
  can continue local/cross-machine delegation or recover an Operation only while its
  signing device still authorizes as Owner. It has no human-root reference: the receiving
  machine signs the next input itself. A machine-signed input remains invalid as a
  `derivedFrom` root. Machine-owned inputs retain separate authorization. Owner recovery after the driving turn ended remains available.

## Shared-member cross-machine derivation (future)

This is a direction the owner prefers, not an approved design; it is left for later Spec
discussion.

- When an agent wants to derive work on another machine, the originating user receives an
  approval request.
- If the user approves on one of their own personal devices, that device produces the
  signature. It binds the workspace, genesis, origin turn, target machine, target operation
  and expiry.
- The target machine verifies that signature and authorizes the originating member's rights
  ∩ the target machine's sharing policy ∩ the project scope.
- The target machine does not need to read the origin session.

## Alternatives

- _A delegation token pre-signed by the member's client._ Rejected by the owner. It is a
  new wire format and needs desktop, Web and mobile changes.
- _An origin taken from `author` or another unsigned field._ Rejected. A member could edit
  it without breaking the signature check.
- _Threading a flag through the MCP and Operation layers._ Rejected. Any layer that
  dropped it would silently yield owner authority. Classification happens where the row is
  written instead.

## Consequences and limits

- Root quota receipts live in control SQLite, scoped by genesis, workspace, root Session
  and root Turn. The control v1-to-v2 extension preserves retirement evidence; the main
  journal remains schema 3. An exclusive transaction commits each deduplicated quota
  reservation before the start claim. A crash or failed start may spend a slot, but
  cannot restore it. Exact retries reuse the receipt; execution-log reset preserves it.
- Write classification, requester resolution and start admission recheck the root
  signer through the existing ledger/sharing gate. Known removal, device revocation or
  sharing withdrawal denies new same-machine descendants and pending starts. Member hops share 20
  reservations across restarts. SQLite and signed-ledger tests cover these boundaries.
- Control schema v2 requires the updated runtime; older binaries refuse this store.
- The RPC dispatch fast path never verifies this machine's own inputs, because only the
  signed row can carry `derivedFrom`.
- Signed-ledger/SQLite tests cover Owner cross-machine verification and starts, 22 Owner
  starts, member quota/retry isolation and steering policy. Member cross-machine
  derivation, hosted backend checks and real-device behavior remain unverified.
- Related: [machine sharing](../../proposed/architecture/2026-10-28-e2ee-machine-sharing.md); [#2149](https://github.com/LodyAI/Lody/pull/2149).
