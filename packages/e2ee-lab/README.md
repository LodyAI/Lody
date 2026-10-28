# Public E2EE Lab

[中文](README.zh.md)

A private, synthetic Lab consuming public `@lody/e2ee-core` exports and released
SDKs. It runs real loopback HTTP, SQLite, HPKE, Loro/Flock and OS processes.
Migration remains incomplete; this package does not enable production E2EE.
E2EE has not shipped, so old data, ledger and API compatibility is out of scope.

## Run

Use the repository's supported Node and pinned pnpm, initialize public submodules,
and install the frozen lockfile in a standalone checkout. Dependency versions
come from [package.json](package.json) and the root lockfile.

```sh
pnpm install --frozen-lockfile
pnpm --filter @lody/e2ee-lab typecheck
pnpm --filter @lody/e2ee-lab test
pnpm --filter @lody/e2ee-lab lab run /absolute/new-output-directory
pnpm --filter @lody/e2ee-lab lab run /absolute/another-new-directory actions.json
pnpm --filter @lody/e2ee-lab lab inspect /absolute/new-output-directory/evidence.json
pnpm --filter @lody/e2ee-lab lab replay /absolute/new-output-directory/evidence.json /absolute/new-replay-directory
pnpm --filter @lody/e2ee-lab lab minimize /absolute/failing-run/evidence.json /absolute/new-shrink-directory
```

`run` requires a new output directory. The default plan executes 39 actions;
custom plans accept an array of at most 256 actions or `{ actors, actions }` with
explicit Owner/Admin/Member/Guest actors and member-bound devices. Unsupported
actions and accessors fail before execution; missing required observations fail explicitly.
SIGINT/TERM closes admission and awaits actual child termination.

Negative expectations require an exact refusal, for example:

```json
{ "ok": false, "refusal": { "tag": "LabContentError", "code": "decrypt_failed" } }
```

An unrelated typed failure, defect or untyped error is a harness failure.
Each applicable ok/outcome/text/unchanged-state check retains its own verdict;
a passing check cannot erase another measured violation or missing measurement.

| Exit | Meaning                             |
| ---- | ----------------------------------- |
| 0    | The measured action contract passed |
| 1    | Harness failure                     |
| 2    | Measured violation or coverage gap  |
| 64   | Invalid CLI usage                   |

`evidence.json` records actual loaded source/release hashes, signed originals,
protected wire bytes, schedule, observations and coverage gaps. Referenced
`fixture/*-transport.jsonl` files contain protected protocol traffic without
credentials. The separate `private-replay/` directory retains synthetic device
exports, initial signed records and per-action original inputs for replay/shrink;
it uses directory mode `0700` and file mode `0600`. Keep it private: `evidence.json`
references its format/digest and cannot replay actions without those files.
`inspect` recomputes judgments from recorded observations instead of trusting saved verdicts. It does
not authenticate an artifact or rerun its scenario. Execution and inspection use
one action-semantic validator and one observation summary. Timing is diagnostic only.
A fixed120s harness watchdog interrupts stalled scenarios, kills/awaits owned
children and releases resources before returning `LabScenarioError/watchdog`
(CLI exit1). Final evidence is written only after successful owner cleanup;
this watchdog is not a performance pass threshold or strict freshness B.
The test suite uses a 180-second outer watchdog (120 seconds for hooks) instead of per-case
5/10/15/20-second arrival budgets. Tests wait for explicit events or actual
operation completion; an operation ending before its required event is a harness
failure. The outer bound leaves cleanup time after the inner 120-second scenario
watchdog. Slow execution alone is not evidence for a protocol refusal. After
SIGKILL or shutdown acknowledgement, the process owner waits for actual `close`;
it does not release resources merely because five seconds passed.

## Entry points and owners

| Entry                                                                    | Responsibility                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./workspace-session`, `./full-session`                                  | Existing admitted control/[P09](../e2ee-core/README.md#terms), identity, keys and per-document owners; reauthentication closes the previous owner |
| `./workspace-creation`, `./workspace-creation-request`, `./host-session` | Durable genesis-first creation and complete HTTP/Riverrun/SQLite restart with independent minima                                                  |
| `./repro`, `./repro-runner`, `./attacks`, `./attack-transport`           | Captured reads, original-input replay/shrink, actual response controls and bounded attack measurements                                            |
| `./join-session`                                                         | Durable original signed join intent; retry after lost receipt, then ordinary startup after genuine admission                                      |
| `./key-round`                                                            | One finite repair/receive/report/distribution pass; blocked tasks and page cursors remain explicit                                                |
| `./content-session`, `src/platform/flock-session.ts`                     | Loro/Flock adapters sharing one document lifecycle and atomic native-state/cursor storage                                                         |
| `./host`, `./http-identity`                                              | Synthetic challenge/bearer HTTP, signed genesis discovery, joins, mailbox and bounded control/content transport                                   |
| `./driver`, `./actions`, `./scenarios`                                   | Native Effect permits, finite actions, real process crashes and measured evidence                                                                 |
| `./snapshot-cache`, `./reference-model`, `./replay`                      | Reverified ledger snapshot bytes, independent predictions and inert-material comparison                                                           |

The receiver owns one protected installed-key store. The distributor and full
session borrow its `installedEpochKeys`; they do not reopen duplicate owners.
Native phases use Effect directly. `LabCallbackRunner` exists only for actual
Node/SDK Promise callbacks; unused attack hooks and Promise-phase APIs are removed.
Parent identities use JSON tuples; replay compares exact parent and occurrence.

## Finite key work and explicit results

`session.keyRound(limit, cursors)` executes one page per phase. Pass each returned
phase's `next` back under its own cursor name (`repairs`, `resumed`,
`reportsBeforeSend`, `reconciliation`, `delivered`, `reportsAfterSend`);
the top-level `next` belongs to `received`. Result pages use `repairResults` and
`deliveryResults`. These hints are not durable offsets and do not select authority.
A blocked first page does not prevent explicitly continuing to later work.

Call `enqueueRepair(stableId, rejectedDigest?)` explicitly: reject only an exact
known-bad frame, and retry local storage/native failures without inventing a new
request ID. `receiveResults`, `repairResults` and `deliveryResults` expose retained
outcomes. After consuming one, call the matching `acknowledgeReceive`,
`acknowledgeRepair` or `acknowledgeDelivery` with its exact ID. Rounds never ACK
automatically. Delivery ACK frees active task capacity; all original rows remain.

Process actors expose the same work through `keyCommand`; custom CLI action plans
can use it directly, for example:

```json
{
  "kind": "key-command",
  "actor": "peer",
  "command": { "operation": "repair", "requestId": "explicit-repair-1" },
  "expect": { "ok": true }
}
```

Commands are `repair`, `keys` (optional `limit`/`cursors`), `key-results`, and
`acknowledge-key-result` (explicit `resultKind` and `resultId`). Worker replies keep
the real results and page hints. No background drain, automatic ACK or new store
owner is added.

## Authority, persistence and shutdown

Existing sessions require independent local/network checkpoint pins. Read startup
may use an explicitly qualified snapshot origin; P09 writes still require the
already published full signed control prefix, including original genesis.
Discovery, SQL rows, offsets and IPC observations cannot select authority.
Private IPC points are checked against independently witnessed signed originals.
Failed ledger reads or SQLite writes retain verified history and cursor together;
P09 retries the original signed bytes, and ACK follows durable feed verification.

Stored credentials bind the actual device and Org; JSON cannot choose a sender.
Recovery devices can receive/repair and authorize their own new personal device,
but cannot send epoch envelopes or write content. Current sender eligibility is
checked separately from lawful historical content authentication. Join receipt is
inert. Snapshot cache reads reverify caller-pinned qualification; eligibility alone
never admits a snapshot or establishes current authority.

Each document commits native state and its exact SDK cursor atomically. Remote
authentication/decryption/format failure or local corruption stops only that
document. Network/timeout/5xx/409 errors and permission refusals retain an active
document and its durable pair; they can be retried without full-history recovery.
SQLite stores share the current-format connection helper. Opening validates the
file identity and bindings; local hostile-process mutation audits are outside the
threat model. Signed history is still verified on reopen and transaction/target-row
readback semantics remain in place.
Rejected native snapshots first replay verified retained history; if that prefix is
trimmed, repair-enabled sessions retry the next authentic snapshot. The validated
410 recovery cause stays retryable, including when a prior provider check failed.
Explicit recovery rebuilds the native owner and uses the patched SDK's available
history or authenticated content snapshot plus suffix. An ordinary read from the
beginning can return HTTP 410 after native snapshot retention while bootstrap still
succeeds; this does not restore the pruned prefix. Insufficient recovery material
fails closed, without resetting host offsets or deleting snapshots. Flock uses an
explicit monotonic logical clock.

Shutdown stops admission, aborts requests and waits for actual raw work/body
settlement before earlier storage/native owners close. Concurrent close callers
share completion, including cleanup failures. `StreamsClient.close()` publishes
protocol EOF and is never used as disposal. CRDT SDK close does not await every
one-shot operation: join raw work, close subscriptions/SDK, then free Loro.
Flock has no public deterministic free/dispose; drop references after settlement.
Abort alone does not prove stopped work or guarantee bounded native shutdown.

HTTP consumers share one bounded body reader inside their existing raw lease:
EOF releases the reader; incomplete reads await cancellation before releasing it.
The shared policy gate screens current reads and control CAS only. Key mailbox and
content writes use their actual dedicated admission paths; it has no speculative
key/content/snapshot write permissions. Control uses the concrete SDK adapter's
genuine read result rather than replaying the same history twice.

## Remaining boundaries

- After [loro-streams#421](https://github.com/loro-dev/loro-streams/pull/421) is released,
  upgrade the SQLite dependency and delete `patches/@loro-dev__sqlite-riverrun@0.3.0.patch`.
- Production checkpoint qualification acquisition; the current synthetic host now persists verified originals/checkpoints and resumes creation or lost-ACK gaps.
- Production qualification and retention policy for content snapshots; the current content-v0 field authenticates the exact continuation position.
- Recovery vault and production/native candidate protection.
- Full adversarial/live collaboration exploration. Original-input replay/shrink, captured reads and measured backend/insider probes have explicit coverage; freshly resealed ciphertext equality is not promised.
- Comparison-note authority, strict freshness B, native key custody and product wiring.

Restricted A covers trusted initialization-time protection of installed keys only.
The known-key AES protector and exportable devices are synthetic fixtures, not OS
custody, candidate backup or historical-sender-envelope restoration B. Tests,
remote CI, independent review and product acceptance remain separate evidence.
See the [manifest](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/.agents/docs/e2ee-migration-manifest.json),
[composition note](../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.md#module-and-validation-boundaries)
and [provenance](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/packages/e2ee-lab/migration-provenance.json). Full earlier checkpoints remain in
[Git at 5ab9394](https://github.com/LodyAI/Lody/blob/5ab9394392a3577a76b14ab0552c33f755b3ce48/packages/e2ee-lab/README.md).

## Local publication and explicit snapshot startup

An optional `epochRotation: { path, mode, protector }` initializes a separate local
candidate owner in the full workspace session. `rotateEpoch`, `resumeEpochRotation`
and `acknowledgeEpochRotation` reuse the control actor's P09 journal and the one
receiver-owned installed-key store. Document seals select the current genuine
epoch. This combines local candidate recovery with the complete staged publication
described below; vault and production/native protection remain separate.

An optional `snapshot: { bytes, trust, offset }` selects an independently qualified
ledger/auth snapshot origin in existing-workspace startup. Capture/verify precedes authentication;
metadata cannot choose authority. Reopening requires the same explicit origin and
an independent expected endpoint. Read startup avoids the old control prefix;
P09 writes still require full-history verification. Production trust acquisition,
production snapshot qualification acquisition and snapshot-only P09 writes remain incomplete.

## Current content snapshots and atomic removal consumers

Document configuration explicitly enables `snapshotUpload: true` before
`uploadSnapshot(id)`. The Lab uses the released SDK's internal-marked
`uploadSnapshotForTesting`, not a public production upload API. Provider header4 is
exactly `[4]`. Content v0 carries a u16be byte length and raw ASCII continuation
offset immediately after its signing public key; the entire field enters the
signature and AEAD. All four document purposes share the same leaf key and retain
docEpoch=0. Update content-frame overhead stays 143 bytes; snapshots add 2 bytes plus
the offset byte count. The gateway checks an actual record boundary no later than the native
head, without interpreting opaque caller offsets. Readers compare the exact
continuation after decryption; native document state and cursor commit together.
The [three-role plan](test/plan-snapshot.test.ts) bootstraps Loro/Flock snapshot plus
tail, rejects a moved response offset, observes the real trimmed-history 410, and
automatically retries an authentic native bootstrap before reopening its durable
result. The SQL failure case still proves that neither half of the durable pair
advances when replay persistence is refused. It preserves native retention and ordinary HTTP 410.

`removeMemberAndRotate(member)` shares the existing candidate publisher/P09 and
writes one removal+epoch record. A real admitted R now exercises personal-device
proof/submission, lost-receipt original recovery, new authentication, HPKE receipt
and document reads. It does not add a recovery file or vault. `comparisonNote()`
exports only a refreshed personal-device observation. Raw equality remains
unconfirmed; callers separately supply the exact tuple from their actual trusted
channel for independent confirmation.

The local snapshot gateway uses an explicitly initialized publication journal;
there is no memory fallback. After an unknown PUT outcome, its host-owned
`resumeSnapshot` confirms the saved original through native GET without another
PUT. Accepted exact retries cannot resurrect an older snapshot. Calling the SDK
upload hook again creates fresh random ciphertext, so a second upload at the same
position correctly conflicts. One resource/model gateway stays alive until raw
work settles; multi-host fencing and crash-atomic Riverrun+SQLite writes are not
provided. An expired unconfirmed first attempt remains blocked rather than being
silently reauthorized by a new token. This fail-closed state is explicit evidence,
not proof of complete host availability recovery.

## Resumable creation and measured reproduction

Creation consumes a public signed genesis and a separately saved initial installed
key. The client stores the original before POST; the host publishes it as the first
control record, verifies the complete readback and saves its observed history and
opaque cursor before replying. A crash or lost ACK retries those bytes. Reopening
the host still requires an independent minimum pin; a receipt or SQL row cannot
choose client freshness. Binding a token neither renews it nor creates membership.
This is the one current experimental Lab layout, with no metadata-prefix reader.

`replay` runs recorded actions/permits on fresh real processes and SQLite owners,
reusing the original synthetic identities, signed records, HPKE/ciphertext frames,
prepared candidate/outbox inputs and captured native local-edit deltas. Actual
HTTP/P09, SDK import, persistence and cursor commits execute again; recorded
replies, terminal results and document/cursor post-state are not injected. It
compares measured outcomes, typed refusals, text, fault hits and within-run durable
relationships. No secure RNG is replaced and fresh resealing equality is unsupported.
`minimize` first reproduces the original measured failure, then gives each finite
candidate fresh files/owners with those original inputs and retains the same
concrete failed observation. Missing dependencies and unrelated harness errors do
not preserve a failure.

For exact original wire reads, `replayLabCapturedReads` takes public signed history,
header3/header4 ciphertext and expected plaintext hashes. The caller independently
supplies the checkpoint and key capability; the pack contains no key or self-chosen
trust. It verifies and decrypts original bytes without replacing secure randomness.

The scenario wires private write facts to the independent reference model and
scans native SQLite `entries` and `snapshots` bodies for known synthetic plaintext.
This read-only harness observation includes retained snapshots while preserving
the actual ordinary HTTP 410. Evidence records the source and bounded row/byte
counts; SQL does not select ledger authority. The attack observer also
measures forged control, context/current-author refusal and excluded-insider old-key
reads. Its attacker ports carry backend bytes, never honest keys or client paths.
Each property remains pass/violation/unavailable/harness-error independently; a
backend scan alone does not establish full confidentiality or whole-Lab acceptance.

## Whole-host and offline continuation

`makeLabHostSession` owns real Riverrun, HTTP and all local stores for one Org. Open requires an
independent minimum checkpoint and verifies actual remote history before exposing HTTP. Authorization
also refreshes that history. A verified observation that fails SQL persistence blocks authority and
checkpoint export in that object, including attempts to roll back to an older prefix. Successful
persistence restores service. Unpersisted knowledge is not promised across processes; reopen still
requires the external minimum.

Actual restart covers original P09 pending records, GET-only confirmation of an unknown snapshot PUT,
and fresh authentication followed by keys, joins, Loro and Flock work. HTTP and raw bodies finish
before Riverrun and databases close.

`session.editOffline(id, text)` persists native edits with the previous cursor without networking,
key lookup or sealing. `flushOffline(id)` uses the released SDK to synchronize local deltas under
current genuine epoch and permissions. Reopen, concurrent-member merge, SQL retry and removed-member
refusal preserve local edits. Once an update is sealed, the document's SQLite owner retains the
original header/ciphertext, AAD and plaintext digest until SDK confirmation. Network
retry, including close/open, reuses these originals; it does not reseal or duplicate
local edits. Flush the pending write before making another local edit. No separate
queue owner or new transport protocol is introduced.

Finite plans use `makeLabAttackTransport` / `runLabAttackPlan` to drop, duplicate, truncate, replace,
change allowed headers or explicitly delay actual responses, or temporarily retain and later release a member's verified
old prefix. Plans receive no credentials or device secrets; actual response events report hits. A
withheld prefix is pending synchronization, not automatic proof of a signed fork. Confirmation still
requires an exact tuple obtained over an independent channel. Three-member rotation/exclusion, offline
continuation and original-byte reads have separate measurements, not a blanket attack-coverage claim.

## Staged publication and terminology

Rotation durably retains the candidate, original signed record and every post-state
recipient frame, stages the whole group, verifies exact readback, then invokes P09
CAS. Conflicts discard the candidate; uncertain/crashed attempts reuse originals.
Session keyRound verifies and receives a committed staged group before ordinary
mailbox/repair. Recipients of a genuine committed complete group can recover after
permanent publisher loss without its disk. This replaces the old independent
publisher-backup options; it does not approve a vault or native custody. Direct CAS
without staging remains a measured manager-withholding availability limitation.

[P07–P14, D12, strict B and RestrictedA glossary](../e2ee-core/README.md#terms).

Staging deletion is limited to the original record's authenticated device. The
SQLite port is opaque: it does not verify a client's occupied claim against the
ledger. The honest publisher checks that condition separately; another manager
cannot delete its group even when providing a genuine occupied tuple.

## Current integration round

`full-session` consumes public `E2eeWorkspace`. Inviter-pinned snapshots travel through the authenticated join mailbox and reopen from the retained origin plus verified suffix. Historical devices may read only the control ledger to observe their own revocation; this grants no content, key, mailbox or write access. The SQLite vault adapter implements the opaque immutable-entry/index-CAS port. Synthetic protection is not desktop custody evidence.

Every action records an independent pre-action prediction and measured comparison. Transport/storage failures are not permission-refusal proofs; missing observations remain unavailable. `explore <directory> <goal-and-actors.json>` is optional and manual, using `OPENAI_API_KEY` and `E2EE_LAB_MODEL`. It sends only the explicit synthetic goal, actor configuration and action schema, and never runs in CI. Model expectations are discarded; actual property violations count only after fresh deterministic replay. Tests use recorded replies and no model network. See [Responses JSON mode](https://developers.openai.com/api/docs/guides/structured-outputs).

Snapshot admission uses the backend `record-boundary` HTTP extension rather than internal tables. The exact SQLite 0.3.0 dependency patch carries the matching upstream change; this is not claimed as an unmodified published capability.

## Synthetic exit canary

Run `node packages/e2ee-lab/bin/e2ee-canary.mjs /absolute/manifest.json` from the
repository root. The manifest contains `canaries` with `message`, `title`,
`fileName`, `mcpEnvironment`, and `machineConfig` markers (each an ASCII
`CANARY-` prefix plus at least 24 random characters), and `sources`, an array of
`{kind: "streams" | "http", id, path}`. Paths are absolute files containing
server-side Streams storage bytes or captured HTTP request bodies. Include the
WAL when observing an active SQLite server. Never point this at client caches:
local plaintext storage is explicitly allowed. Inputs are synthetic only, with
an aggregate 256 MiB observation limit.

The command checks UTF-8, hexadecimal and base64 representations, reports only
field/source/offset, and exits 0 for no findings, 2 for a leak or missing exit,
and 64 for invalid input. Empty observations cannot pass. This is a bounded
canary check, not a proof against compression, arbitrary encodings, or an
unobserved route. `test/canary.test.ts` runs real protected Loro/Flock peers over
local HTTP, captures request bodies, scans native Riverrun entries, and proves
that an injected plaintext regression fails. Full product acceptance still needs
all Convex/Worker/Streams requests captured while using the actual application.
