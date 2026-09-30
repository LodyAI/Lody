# BeeKEM / Keyhive vs Lody permission ledger

Status: proposed
Translation: current

[中文](./2026-09-18-beekem-keyhive-feasibility.zh.md)

## Abstract

IACR ePrint [2026/1434](https://eprint.iacr.org/2026/1434) is BeeKEM, a
decentralized continuous group key agreement protocol, not a permission or
identity system. The surrounding Keyhive stack (convergent capabilities, a
group-management CRDT, BeeKEM, Beelay) is a concurrent, server-optional access
control design for Automerge. Lody’s confirmed first version is the opposite
shape: one Owner, a linear signed ledger with CAS total order, trusted Streams
freshness, explicit roles and device kinds, and linear HPKE epoch envelopes. A
wholesale import of BeeKEM or Keyhive would reverse those decisions and still
leave recovery devices, machines, Guest, and execution leases unimplemented.
The crate is pre-alpha and unaudited; Loro Streams is a stronger sequencer than
BeeKEM assumes, so its concurrency machinery would sit idle. Nested groups are
the only piece that maps onto future Team-scoped keys; they still need a Lody
policy layer. Do not rewrite the whitepaper to treat BeeKEM as the permission
model.

## What the paper actually specifies

BeeKEM ([Yen, Fábrega, Da, Kleppmann, Mumm, Park, Zelenka](https://eprint.iacr.org/2026/1434))
is a DCGKA: members agree on a sequence of group secrets under authenticated
causal broadcast, without a delivery service that serializes operations.

- Data structures: a TreeKEM-style binary tree of NIKE/DH keys, plus a hash DAG
  of Create/Add/Remove/Update operations.
- Common-case Update cost \(O(\log n)\), degrading to \(O(n)\) under concurrent
  updates or blank/conflict resolutions.
- Security: parameterized \(\kappa\)-FSU, PCS, and a new **cross-fork security**
  property. Concurrent Add/Remove materialize with **remove-wins**. After Add or
  Remove the root secret is undefined until the next Update.
- Implementation: Rust in [inkandswitch/keyhive](https://github.com/inkandswitch/keyhive/tree/main/beekem);
  Keyhive/Beelay remain pre-alpha and unaudited.

Keyhive’s “auth stack” is three layers, of which BeeKEM is only the third:

```text
convergent capabilities  →  group CRDT (devices/teams/docs)
                         →  BeeKEM group secret + causal chunk keys
Beelay: RIBLT membership sync + sedimentree ciphertext
```

Keyhive explicitly excludes human identity binding, a small role set, interactive
protocols, and a central authority. Documents and people are both groups of
Ed25519 principals. Write authority is a capability graph; read authority is
possession of the current group secret.

## Lody as implemented and specified

Binding intent: sibling-tree whitepaper
`../lody-e2ee-design/specs/e2ee/whitepaper.md` and
[ledger spec](../../../../specs/e2ee-ledger.zh.md).
Core: `packages/e2ee-core` `Ledger.verify` / `applyOperation`, HPKE
`sealEpochEnvelope`, history packets on `publishEpoch`.

```text
signed linear ledger (CAS)  →  who may act (role ∩ device kind ∩ canManage)
independent HPKE envelopes  →  current epoch key to each live device + R
history packet in the epoch record  →  K_n wraps K_{n-1}
JWT / 15-minute lease       →  cloud pull and machine execution cutoff
```

Confirmed and already coded: unique transferable Owner; Admin may admit Members
and rotate epochs but cannot remove members or appoint Admins; Guest read-only;
machines have no `canManage`; recovery device R receives keys and may admit that
user’s personal devices only; device revoke is this-Org and the named device;
snapshot join is out-of-band genesis + Owner/Admin endorser + attested head.
The whitepaper already cites DCGKA as research background and **rejects** its
concurrent group protocol in favor of trusted backend order. That choice is
recorded in the [control-log note](2026-09-12-e2ee-control-log.zh.md); this
note does not reopen it.

## Why a wholesale import is not feasible

| Axis | BeeKEM / Keyhive | Lody first version | Clash |
| ---- | ---------------- | ------------------ | ----- |
| What is “authz” | Capability graph + concurrent group CRDT | Sequential RBAC ledger | Different product |
| Ordering | Causal merge; concurrent ops keep conflict keys | CAS total order; first commit wins | Different answers for invite-then-remove |
| Revoke vs concurrent add | Remove-wins after merge | Whoever CAS-succeeds first | S4 in the security model |
| Owner | No unique Owner; two admins may revoke each other | Exactly one Owner | Product invariant |
| Roles / devices | Unconstrained principals | owner/admin/member/guest; personal/machine/recovery | Keyhive antigoal |
| Identity | Out of scope | User identity, membership instance, email UX | Still needed above BeeKEM |
| Backend | Optional untrusted relay | Honest Streams: complete prefix, no fork/rollback, JWT | Lody A3/A5 |
| After membership change | Root blank until Update | Keep writing current epoch until Owner/Admin rotates | Availability vs PCS |
| Key cost | \(O(\log n)\) sequential Update | \(O(\#devices)\) HPKE envelopes | Fine at ~20 users |
| FS / history | BeeKEM has \(\kappa\)-FSU; Keyhive app layer still shares history | Shared retained history; no FS | Same CRDT constraint |
| Recovery / machines / 15 min | Not specified | First-version requirements | Would still be Lody work |

Importing the stack would not delete those Lody surfaces. It would replace the
already-implemented ledger, snapshot join, and epoch outbox, then re-implement
Owner, Guest, R, machines, and execution leases on top of a CRDT whose merge
rule (remove-wins, mutual admin revoke) is the rule Lody already discarded.

BeeKEM’s proofs also do not transfer. They assume authenticated causal broadcast
and honest protocol execution. They do not prove Lody’s snapshot endorsement,
JWT cutoff, or machine command authorization. Keyhive’s own notes state BeeKEM
FS is not Keyhive FS, because causal chunk keys re-expose predecessors — the
same trade-off Lody already made with history packets.

## What is worth learning (without adopting the stack)

1. **Keep authorization and keys split.** Already the design. BeeKEM is a key
   protocol; membership policy lives elsewhere. Do not let TreeKEM leaves become
   the role matrix.
2. **Application-level FS is the wrong goal for a CRDT Org.** Both projects
   concluded that decrypting a current chunk must unlock retained history.
   Lody’s history packet is the sequential analogue of Keyhive causal keys.
3. **PCS is an Update policy, not a new ledger.** Lody PCS today waits for an
   Owner/Admin `publishEpoch`. BeeKEM’s per-leaf Update is automatic healing
   after compromise. The cheap version is “rotate soon after revoke / on a
   timer,” still using HPKE. TreeKEM only pays off when envelope fan-out, not
   policy, is the bottleneck.
4. **Cross-fork security is irrelevant while A3 holds.** CFS exists because
   DCGKA allows partitions to define different group secrets. Lody forbids
   control-plane forks. If the backend lies, Lody already admits withheld
   revoke and split Owner history; BeeKEM does not repair that without dropping
   CAS.
5. **Pull vs read vs write.** Keyhive’s pull capability matches Lody’s JWT /
   snapshot-admission split: ciphertext retrieval is weaker than decrypt, which
   is weaker than write. Keep those checks separate; do not treat `open` success
   as current write.
6. **Later adapter only, if ever.** A future `KeyDelivery` that speaks BeeKEM
   (or ordinary TreeKEM) could take the **current verified device set** from
   `Ledger.state` and produce epoch secrets. The ledger would still decide who
   is in the set. Do not feed BeeKEM concurrent Add/Remove from offline clients.
   Leaves should be devices, with R and Guest excluded from Update/write.
   This remains unjustified at the first validation size.

## Alternatives considered

- **Adopt Keyhive wholesale.** Rejected: concurrent capability authz, no Owner,
  no identity, pre-alpha, Automerge/Beelay-shaped sync, contradicts CAS ledger.
- **Adopt BeeKEM only as the Org key layer now.** Rejected for v1: linear HPKE
  is acceptable; blank-root-until-Update fights availability-first rotation;
  Wasm/Rust binding and concurrent Update graphs are new attack surface without
  a scaling need.
- **Adopt MLS/TreeKEM with Lody’s existing total order.** Closer than BeeKEM,
  because Lody already has a sequencer. Still unused: whitepaper forbids MLS;
  epoch rotation is rare and Owner/Admin-gated; FS is not a goal.
- **Keep current ledger + HPKE + history packets.** Retained. Matches confirmed
  intent and the shipped `e2ee-core` surface.

## Follow-up: maturity, Team, and Streams (2026-09-18)

A later question asked whether BeeKEM is mature enough to integrate, and whether
rewriting the whitepaper to use it as the **permission model** could cover
long-term Team plus people, devices, and machines. Conclusion: **do not rewrite
the whitepaper onto BeeKEM as authz.** Nested Keyhive-style groups are the only
piece that maps onto future Team isolation. The crate is not a product-ready
auth system, and Loro Streams already supplies a stronger (and different)
ordering property than BeeKEM needs.

### Maturity

| Signal | Evidence |
| ------ | -------- |
| Paper | ePrint 2026/1434, proofs under DCGKA games; preprint, not an IETF/MLS-class standard |
| Crate | `beekem` 0.3.0 (2026-06-26), `keyhive_core` 0.5.0; ~two in-tree dependents |
| Authors | Paper calls the Rust code “production-ready”; Keyhive notebook 04 says **do not use in production**, unstable API, **no audit** |
| Apps | Ink & Switch Patchwork; Automerge/Beelay shaped, not Loro |
| Who may Add/Remove | BeeKEM itself does not restrict callers; docs assume Keyhive causal delivery |

“Mature enough to wire as Org keys behind our ledger” is a research adapter.
“Mature enough to replace the permission model” is no.

### BeeKEM is still not a permission model

Rewriting the whitepaper “to use BeeKEM as the permission model” would actually
adopt three products:

```text
Keyhive groups + capabilities   →  who exists (Org/Team/person/device)
BeeKEM                          →  shared read key for one group
Lody policy (still required)    →  Guest, canManage, R, machine execute, 15 min
```

BeeKEM membership is binary: a leaf decrypts the group secret or it does not.
It has no Owner, Admin, Guest, `canManage`, recovery-only, or “this device may
ask that machine to run a command.” Those remain application policy. Keyhive
deliberately leaves human identity and a small role set out of scope.

### Team / people / devices / machines

Nested groups **can** name the long-term shape:

```text
Org
  Team Eng ──► docs {D1, D2}   each document ≈ one BeeKEM group
    Alice (person group)
      laptop / phone / R
    Alice’s machine (individual)
  Team Design ──► docs {D3}
```

That is the interesting import: **per-resource keys**, so Team Eng ciphertext is
not decryptable with the Design epoch. Today’s single Org epoch cannot grow into
that without splitting keys anyway.

It does not finish permission management:

- **Guest / read vs write vs manage** need extra groups or capabilities. A Guest
  leaf on the same BeeKEM tree can decrypt everything that tree encrypts.
- **Machines** as leaves get the same group secret as people. Execution
  authorization (target, command, request id, 15-minute lease) is outside
  BeeKEM. Pairing a machine to one frontend user is a Lody protocol.
- **Recovery R** needs the secret and must not write or Update as policy.
  Compromised R stays in the tree until Remove + a later Update (root is blank
  after Remove).
- **Nested membership churn** is the hard part: adding a device to Alice must
  reach every document BeeKEM tree that includes Alice’s person group. That
  fan-out is Keyhive’s job, not `beekem`’s, and is not specified for Loro.
- If “Team” later means “another encrypted Org under billing,” the current
  ledger already scales by minting another genesis. Nested BeeKEM is only
  required if one Org must hold isolated sub-teams that share some docs.

### Protocol security and performance

Security the paper proves: \(\kappa\)-FSU, PCS, \(\kappa\)-CFS, under ACB and
honest execution. It does not prove: snapshot endorsement, JWT cutoff, machine
commands, “only Owner may remove,” or identity binding.

Application FS remains declined for CRDT history (Keyhive causal keys, Lody
history packets). After Add/Remove the root is undefined until Update — stricter
PCS, worse availability than “keep writing the current epoch.”

Performance (paper, sequential, 8–512 members): Update/Remove \(O(\log n)\)
primitives; new member Process \(O(h_B)\) history replay; welcome grows ~2.5 kB
and ~40 µs per Update. Under partition, post-merge cost grows with the fraction
of members who Updated, up to \(O(n)\). At ~20 users HPKE is simpler. At
hundreds of people × several devices, log-cost rotation beats one HPKE envelope
per leaf — only if rotations are frequent. Lody rotations are Owner/Admin-gated
and rare.

With a sequencer, ordinary TreeKEM/MLS is the closer CGKA. BeeKEM’s extra cost
is concurrent conflict keys, which CAS will almost never exercise.

### Does Loro Streams satisfy BeeKEM’s external properties?

BeeKEM assumes authenticated causal broadcast: causal delivery, eventual
reliability, authenticated sender. The implementation builds ACB from signed
hash-DAG ops over a reliable broadcast.

| ACB property | Loro Streams as used today |
| ------------ | -------------------------- |
| Authentication | HTTP/JWT plus Lody record signatures; not BeeKEM op auth unless we sign each CGKA op |
| Causal order | **Stronger**: CAS total order on one stream. A total order is a valid ACB if every op is appended there |
| Reliability | Not guaranteed to all members. JWT can withhold; hosted `/append-cas` is still **501** |
| Forks / partitions | **Forbidden** by A3. CFS/CUC and conflict keys stay idle |
| PKI for Add | Lody join-request can supply the initial DH key |

Compatible only if BeeKEM ops are serialized on the control stream. Then the
backend matches ACB and **wastes** BeeKEM’s reason to exist (serverless
concurrency). Streams does **not** give mesh/partition operation during an
outage; offline clients still cannot fork the control head. JWT withholding is
desired for revoke and is a different property from ACB reliability.

Beelay (RIBLT + sedimentree) does not replace Streams/Loro. Adopting BeeKEM
keys would still keep Durable Streams for content.

### Implementation complexity

High, even as keys-only: Rust/`keyhive_wasm` or a TS rewrite; map devices to
leaves; blank-root vs current epoch writes; keep JWT admission; keep R and
machines. As permission-model rewrite: replace `Ledger`/`verifySnapshot`/
outbox, implement capability or nested-group policy, invent Team membership
propagation over Loro, accept remove-wins instead of CAS-first, and re-prove
Owner uniqueness if it is still required. That is a new protocol, not an
adapter.

## Limits

This note is research from the ePrint PDF, Keyhive lab notes, crates.io/docs.rs
for `beekem` 0.3.0, the sibling whitepaper/permission ledger, and the current
`packages/e2ee-core` policy, Streams adapter, and handoff (hosted CAS 501). It
does not re-prove BeeKEM, benchmark HPKE vs BeeKEM on Lody workloads, or change
a Spec. No PR. Humans still own any later decision to revisit Team-scoped keys
or key-fanout scaling.
