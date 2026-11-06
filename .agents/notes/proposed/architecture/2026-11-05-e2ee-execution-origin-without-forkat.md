# E2EE execution origin without forkAt

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2344

[中文](2026-11-05-e2ee-execution-origin-without-forkat.zh.md)

## Abstract

The encrypted start gate proves who wrote a Turn or Schedule declaration by forking the
Loro document at the signed update's dependencies and re-importing its exact bytes. That
requires retained ciphertext for every Session and Schedule update, backfill from Streams
and a document-wide fork per frame. The owner decided on 2026-11-05 to drop this after E2EE
acceptance, accepting a simpler interim check; stronger integrity moves to Roost later. This
note proposes evidence by author: signed purpose-8 dispatch originals for human input,
including queued input; a local receipt for machine-authored input; and the frame signer
plus a later-edit check for Schedules. The main trade-off is that a Schedule declaration
no longer proves its exact payload. A human Turn with no dispatch original can no longer start.
Everything here comes from reading main `979b0efc5`; nothing was implemented or run.

## Scope

Three guarantees are not negotiable: an encrypted workspace encrypts or refuses, with no
plaintext fallback; an exact retry keeps the original ID, record, signature and ciphertext;
and non-members and removed or revoked devices gain no execution authority. Any option that
weakens them is marked and not recommended. The ledger format does not change. Nothing here
depends on the Rust local data engine, which is still under discussion.

## Where forkAt runs today

Both forks are in [`execution-origins.ts`](../../../../apps/cli/src/lib/e2ee/execution-origins.ts):
`resolve` for Session Turns and `resolveSchedule` for Schedule declarations. The only route to
`resolve` is `resolveVerifiedExecutionOriginal` in
[`workspace-legacy.ts`](../../../../apps/cli/src/lib/e2ee/workspace-legacy.ts).
Encrypted Sessions always use the Loro history backend: `prepareCreate` forces it and send
admission refuses Roost with `e2ee_history_backend_unavailable`.

| Entry | Row signer | Reaches forkAt when |
| --- | --- | --- |
| Human Turn, dispatch delivery | Client device | No original in `rpcDispatchOriginals` or the receipt cache: preparation failed or timed out, the host lacks the capability, or the Turn lacks `inputConfig`, `userId` or `timestamp` |
| Human Turn, `history` delivery | Client device | Always; `dispatchUserTurn` is not called |
| Queue promotion (`promoteNextQueuedMessage`) | **This machine** | Always. A `queue` delivery stores no original, so the machine-signed promoted row is the only evidence |
| Refused steer | Client device | Not on the client's `promoteGuideToFollowUp` route, which dispatches. Whether a CLI-side promotion can still run in encrypted mode needs confirming; queue rules would apply |
| Agent-driven owner work (`lody session` create/send, MCP) | This machine | Always: a self-signed original falls through to the signed row |
| Derived input (`derivedFrom`, shared-member derivation) | This machine | Always. Its origin Turn is resolved again below |
| Derivation origin lookup (`classifyOrigin`, `verifiedOrigin`) | Member | `lookup.origin` skips the document's original. Only a cached received original avoids the fork. An owner's live Turn short-circuits the write-time check |
| Generated Schedule Turn (`scheduleRun`) | This machine | Always, then `resolveSchedule` runs as well |
| Automation queue row (`pushMessageQueue`) | This machine | Always, through queue promotion |
| Schedule handoff (`schedule-engine` `authorize`) | Definition signer | Always; one fork per signed frame holding the declaration |
| Schedule actual start (`claim` → `authorizeSchedule`) | Definition signer | Always, repeated for each resolved project target |
| Schedule manual run | Definition and request signers | Both of the above, for two declarations |

### Findings that shape the design

- **Queued input needs its own evidence.** Promotion writes the history row on this machine,
  so the row's signature names the machine. Every option has to carry the input's author
  separately, independently of forkAt.
- **The dispatch original is already a signed intent for human input.** It binds request ID,
  target machine, expiry, session, Turn, `userId`, timestamp and `inputConfig`, and that
  config normally carries `prompt` and `inputBlocks`. `resolveDispatchTurnInput` prefers them
  over the row's `items`, so the executed text is covered. Only a config with no blocks falls
  back to unsigned `items`.
- **The client already prepares a frame for queued sends.** `refuseKnownWithdrawnTarget` calls
  `prepareEncryptedDispatch` for every encrypted send, then discards the result.
- **The fork carries more than the signer.** Comparing the reconstructed row with the current
  one also covers later changes to `inputConfig`, `items`, `scheduleRun` and `derivedFrom`.
  Row fields are separate operations, and status updates share the same
  map, so a container-level "changed since" check cannot replace it for Turns. It does work
  for Schedules, where `scheduleChangedSince` already exists and needs only a version.
- **Machine-authored rows prove little by signature.** The machine already knows it wrote
  them. `seal` retains nothing, so `retain` sees such a frame only if it reads its own
  update back, or through backfill. Whether that adds start latency was not measured.

## Options

| | A: drop the fork, keep the frame signer | B: evidence by author (recommended) | C: signed execution intent |
| --- | --- | --- | --- |
| Human Turn | Signer of the frame holding the creation op | Dispatch original only | New signed record |
| Queued input | Unsolved without extra work | Dispatch original stored with the row | New signed record |
| Machine input | Signer of its own frame | Local receipt with a row digest | Machine-signed record |
| Schedule | Frame signer + `scheduleChangedSince` | Same as A | Signed declaration |
| Client changes | None | Queue path only | Desktop, Web, mobile, CLI |
| New format | None | One Session document map, one local table | New signed record and expiry rules |
| `frames`/`spans` | Kept in full | Schedule rooms only | Removable |
| Fails a non-negotiable | **Yes, the third: not recommended** | No; see the guarantees below | No |

**Option A** is the literal minimum, about 40 changed lines with no rollout order. It keeps the
signer of a Turn's creation but no longer compares later row changes with what was signed, so
it does not hold the third non-negotiable. It is not recommended.

**Option C** is the design floated in earlier E2EE discussion: a member device signs session,
Turn, content digest, config, optional `derivedFrom` and Schedule, target and deadline. It is
the strongest and would let `frames`/`spans` go. It also needs a new format, every client,
a deadline that suits a long-lived Schedule (dispatch frames are capped at 15 minutes) and a
Spec revision. It would replace most of what Roost should later provide. Option B reuses the
same idea where a signed format already exists, so C remains a possible later step.

## Proposed design (Option B)

```text
claim(userTurnId)
  resolveVerifiedExecutionOriginal
    self receipt present   -> digest(current row) must match -> machine as requester
    dispatch original      -> openDispatch, bind session/turn/config -> frame signer
    neither                -> pending until the Turn's window ends, then expired
  scheduleRun?             -> authorizeSchedule (frame signer + no later edits)
  derivedFrom?             -> same resolution for the origin, then origin member's rights
  authorizeExecution, journal claim   (unchanged)
```

- **Human input.** The dispatch original becomes the only evidence. The row's `inputConfig`
  must equal the signed one, as today; `resolve` and its fork are removed. A config with no
  input blocks is refused rather than falling back to unsigned `items`.
- **Queued input.** The client stores the frame it already prepares in a new document map,
  `queueDispatchOriginals`, beside the row. A separate map matters: the existing gate compares
  configs strictly, and promotion adds `resume`, so an old CLI reading the frame from
  `rpcDispatchOriginals` would deny the Turn. The gate compares the signed config with the
  promoted row excluding `resume`. An encrypted queue row with no frame and no self receipt is
  not started. Editing a queued row changes its config, and originals are immutable per Turn,
  so an encrypted edit takes a new `userTurnId`.
- **Machine-authored input.** Each write site records `(sessionId, userTurnId, digest)` in a
  new table of `execution-origins.sqlite` before the history write. The digest covers the same
  projection the gate compares today. A row with neither a matching receipt nor a dispatch
  original does not start, including its `derivedFrom` and `scheduleRun`, and a missed write site
  fails closed in tests. Automation queue rows record at enqueue, and
  promotion binds the final projection.
- **Derivation.** Origin lookup reads the member's dispatch original from the document or
  receipt cache, then applies the existing rules unchanged. An origin with no frame refuses the
  derivation.
- **Schedules.** `resolveSchedule` keeps retained frames and recovery but no longer forks. It
  opens the frame covering the declaration op, takes its signer, and computes the signed
  version as `doc.frontiersToVV(meta.startFrontiers)` merged with the frame's end vector for
  `scheduleChangedSince`. The fingerprint and declaration are read from the live document.
  [Declarations](../../implemented/bug-fix/2026-10-28-e2ee-schedule-origin-authorization.md)
  are unchanged, so definitions need no re-save.
- **Unchanged.** The `agent-start:<userTurnId>` journal, `authorizeExecution`, freshness fences,
  deadlines, RPC originals and retry behavior. The encrypt-or-refuse boundary is not touched.

### Guarantees by option

| Guarantee | Today | Option A | Option B | Option C |
| --- | --- | --- | --- | --- |
| Signer identity at start | Yes | Yes | Yes | Yes |
| Current-ledger check at start | Yes | Yes | Yes | Yes |
| Executed Turn content matches what was signed | Yes | No | Yes | Yes |
| Displayed `items` match what was signed | Fork path only | No | No | Yes |
| Schedule declaration rejects later edits | Yes | Yes | Yes | Yes |
| Schedule declaration proves its exact payload | Yes | No | No, left to Roost | Yes |
| Human Turn starts with no dispatch original | Yes | Yes | No, the sender sees a refusal | No |

Option B's trade-offs are availability on a missing original and the Schedule payload check.
Both are owner decisions below. A missing machine receipt refuses that input.

## Roost follow-up

Roost history carries seals, owner and sequence rules, and per-writer signing identities. The
[writer identity proposal](2026-10-11-roost-writer-identity.md) gives each independently
writable replica its own key, bound through authorized public scope. Encrypted Sessions cannot
use Roost yet, so integrity checks would attach once they can. The likely seam is the single
resolver: `resolveVerifiedExecutionOriginal` returning `VerifiedExecutionOriginal`. To stay out
of the way, the interim design keeps that one seam, keeps `userTurnId` as the business identity
and the journal key, keeps `scheduleRun` and `derivedFrom` as row fields, and writes no
authority into row fields. Roost's protocol is not designed here.

## Old clients and existing data

E2EE is still at the test-build stage, so "old clients" means earlier test builds.

| Client / CLI | Result |
| --- | --- |
| New client, old CLI | The new map is ignored; behavior is as today |
| Old client, new CLI | Dispatch turns work. Queued rows do not start and expire visibly |
| New client, new CLI | Target state |

- **Order.** Ship the client change first, then flip the CLI gate atomically in one PR. No
  fallback to the fork is kept: it would keep the code this removes. Production deployment and
  acceptance order are unaffected, since implementation follows acceptance.
- **Existing data.** No migration. Terminal Turns are never re-verified because the journal
  answers first; a pending Turn expires inside 15 minutes; machine input in flight at upgrade
  has no receipt, so it expires, and the next Schedule tick regenerates it. Schedule
  declarations and ledger data are unchanged.
- **Mobile.** The mobile source is outside this repository. Its use of `prepareDispatch` must
  be confirmed before the CLI flip; if it lacks one, its Turns would stop starting.

## Reducing `frames` and `spans`

Yes, partly. Session rooms stop writing to them, so the per-update ciphertext growth and the
backfill for Session Turns go away. Schedule rooms keep both. Existing rows stay in place; the
[execution-claim note](2026-10-28-encrypted-agent-execution-claim.md) records that no proof
pruning occurs, so any one-time delete is a separate decision. `rpcDispatchOriginals` and the
new map keep growing with each Turn, as a hex copy of signed input in the document. They are
not pruned here because exact retries depend on them. Only Option C could remove the tables.

## Implementation plan

Line counts are estimates, excluding generated files.

| PR | Change | Size (code + tests) |
| --- | --- | --- |
| 1 | Shared schema and client: `queueDispatchOriginals`, new Turn ID on encrypted edit, visible preparation failure | ~120 + ~150 |
| 2 | CLI: self-input receipts at every write site, still unused by the gate | ~250 + ~250 |
| 3 | CLI gate flip: receipts and originals only, queue rule, remove `resolve` and Session `retain`/backfill | -130/+80 + ~300 rewritten |
| 4 | CLI and shared: Schedule frame-signer path, remove the last fork | ~50 + ~100 |
| 5 | Spec revision, `AGENTS.md`, this note to `implemented/` | Documentation |

PR 3 and PR 4 land last and together in one test build, because this path gates every encrypted
start and invalidates acceptance evidence.

Regression scope: A, B, C, mobile and Schedule all rerun, including:

- Owner and shared-member dispatch, with RPC arriving before and after history.
- Queued input from each, including edit, automation rows and a queue older than its window.
- MCP child Session, chat and Role from an owner Turn and a member Turn; denied cross-machine.
- Schedule definition, manual run, edit-invalidates, signer checks and multi-project.
- Daemon restart mid-claim, an exact retry of an uncertain start, and a snapshot-only replica.
- Device revocation, member removal and sharing withdrawal during a pending start.

The fixtures in `apps/cli/tests/e2ee-runtime.test.ts` carry over, except the case that pins the
Schedule payload check.

## Spec impact

[`specs/e2ee-foundations.md`](../../../../specs/e2ee-foundations.md) needs a human-reviewed
revision: its derived-work paragraph and the origin wording rest on the signed-original chain.
The whitepaper already says this format provides no per-operation authorship proofs, so no
revision is needed there. `apps/cli/src/lib/e2ee/AGENTS.md`,
`apps/cli/src/lib/schedules/AGENTS.md` and the CLI README change with the implementation. This
note does not approve any Spec.

## Open decisions

1. Whether the Schedule payload check may move to Roost, or Schedules keep their fork until then.
2. Whether a human Turn with no original may fail closed (recommended) rather than keep a fallback.
3. Approval of the Spec revision above.

## Alternatives rejected

- *Trust the row with no evidence.* It keeps no signer identity at start, so it does not hold the
  third guarantee.
- *Signed feature frames for Schedules.* Same format work as Option C, with a 15-minute cap.
- *A last-editor check on each row key.* `LoroMap.getLastEditor` reports only a peer and does not
  cover nested containers.

## Verification limits

Inventory and findings come from code reading. No tests ran. `frontiersToVV` exists in the pinned `loro-crdt` 1.17.0 typings, but its
behavior on snapshot-only replicas and the cost of today's fork were not exercised or measured. Mobile behavior is not established from this
repository. Sizes are estimates.

Related: [execution claim](2026-10-28-encrypted-agent-execution-claim.md);
[Schedule origin](../../implemented/bug-fix/2026-10-28-e2ee-schedule-origin-authorization.md);
[derived work](2026-10-31-e2ee-shared-member-derivation.md);
[machine sharing](2026-10-28-e2ee-machine-sharing.md).
