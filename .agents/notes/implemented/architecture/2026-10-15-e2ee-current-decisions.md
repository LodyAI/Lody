# Current public E2EE decisions

Status: implemented
Translation: current

[中文](2026-10-15-e2ee-current-decisions.zh.md)

## Abstract

The unshipped E2EE stack accumulated a separate Note for almost every extraction,
fix and parent synchronization. Most repeated module contracts or stale validation
counts. This record consolidates the choices that still explain the current
implementation; module READMEs own behavior, and the manifest owns source disposition.
Pending protocol and product decisions remain [separate proposals](../../proposed/architecture/2026-10-15-e2ee-open-contracts.md).

## Current format only

There are no deployed E2EE ledgers or stores to migrate. Support one current format
per entrypoint; omit old readers, aliases, JSON imports, dual decoders and schema
upgrades. Current v0/v1 names are authenticated protocol domains, not obsolete
versions to rename. Normal reopening, verified history, historical author identity,
backward epoch-key recovery and original-byte retries remain current requirements.
Source-era export lists do not require restoring obsolete APIs or a second core.

## Trust and authority

Use one registered genuine-view replay/policy implementation. SQL, transport
offsets, ACKs, reports and server revisions cannot select ledger authority. A valid
historical signature grants no current write/send right. Snapshot endorsement needs
independent same-point qualification or a private token from an actual eligible
view; signature-only evidence and equal comparison notes do not supply that trust.
Unknown pre-snapshot hashes and missing user attribution cannot be fabricated.
Current permission and known-prefix checks repeat after asynchronous work.

Host upload admission and honest sealing are different gates. Previously sealed
original bytes may upload under current document-write permission when their epoch
is published in the genuine ledger, including while rotation is required. Only
new seals require the current epoch and cleared rotation flag. The workspace
facade exposes the verified epoch/rotation requirement and personal-manager
eligibility without publishing; Lab uses that signal for a required-rotation round.
Failed vault candidates have no cleanup API and remain permanently retained in
this revision. Retired indexed entries keep their separate risk-confirmed cleanup.

The concrete Streams adapter returns its genuine view from the same verified read;
Lab control reuses it. Generic remote records still require independent P09
verification. Shared route screening covers actual reads/control only, while key
mailbox and content writes retain their dedicated admission.

## Installed-key protection

The restricted approval covers verified installed EpochKeys through a trusted
host protector captured once at initialization. Ordinary callers keep opaque keys;
protection authenticates the whole purpose/Org/recipient/epoch/commitment/key payload.
The adapter can copy plaintext, so this is a trust boundary, not OS isolation or a
complete-erasure promise. Installed keys can reopen after their original sender is
revoked; fresh envelopes still require a current eligible sender. This approval
covers neither historical-envelope restoration nor candidate backup, vault formats,
installed-history product approval or actual platform custody. The existing identity
port and safeStorage string path are not an accepted native protector adapter.

## Durability and lifecycle

Persist the first signed record, ciphertext, report or repair ID before dispatch;
retry originals rather than silently re-signing, re-encrypting or rebasing. CAS has
no unconditional-append fallback. Final row/context readback precedes success;
a disk phase or remote hint is not installation, possession or authority evidence.
Acknowledgement retains originals and frees active distribution capacity; retained
disk history can still grow. Indexed stores replace whole-JSON persistence.

Lab sessions and process/CLI commands expose stable-ID repair, independent page
continuation and all three result/ACK paths. Callers choose when a result has been
consumed; key rounds never ACK or silently discard it. A blocked first page can be
continued without changing IDs or creating another queue owner.
Receive tasks use one pending Install phase: every retry opens the original
ciphertext and performs protected save/reload before signing and queuing a report.
The redundant pre-save phase UPDATE is removed. Local receiver schema2 rejects
the unsupported former schema1 without migration; protocol domains do not change.

One receiver owns installed-key storage; distribution and history consumers borrow
it. Owners reject new work, abort/cancel what can stop, await actual native/SDK/body
settlement, then release storage and native resources. Promise bridges exist only
at real SDK/Node callbacks. StreamsClient.close is protocol EOF, not disposal;
SDK close alone does not join every operation. Clear owned scratch after settlement;
borrowed handles and runtime-internal copies have separate lifetimes. HTTP shutdown
aborts incoming bodies before joining callbacks; reverse Scope finalization must
not make the abort owner wait behind its own unfinished body.
Bounded response collection is one internal helper inside these existing leases:
EOF releases the reader; incomplete work awaits cancel and always releases the lock.

Desktop KEK initialization holds a native SQLite exclusive mutex through actual
safeStorage settlement. Process death releases the OS lock; a private journal
retains only encrypted wrappers and the same random KEK's digest. Reopen validates
that same key before completing or restoring an interrupted replacement. A live
initializer is never displaced using PID, age or timeout. Invalid recovery data
fails closed. Tests exercise actual child termination around journal publication
and wrapper replacement; synthetic safeStorage is not OS-keychain acceptance.

## Verification work

Cooperative native Ed25519 work uses the same pure authority kernel and retains
strict canonical subgroup/scalar checks. Bounded private caches retain exact
mathematical successes, never roles or freshness. Native backend failure is a
harness/backend failure. Persistent internal collections share immutable structure;
public inspection still returns detached data. Full feed reopening remains O(N).

The threat model trusts the local client and operating system. Shared SQLite
ownership checks dedicated-file identity/bindings on open and fully verifies retained
ledger bytes then. Hot operations read metadata and their target rows; no schema,
trigger, external-write stamp or whole-table mutation audit remains. Rollback pins
advance only with a genuinely newer ledger point. Transactions and first-original
readback remain. An Accepted snapshot retains its identity/digest after its obsolete
body is removed; only current/pending bodies consume publication capacity.
Document transport and permission failures stay retryable without stopping the
document; pending SDK writes retain original ciphertext until acknowledgement.
Remote content authentication/format errors and local corruption stop that document.
Core and Lab tests use a uniform 180s outer watchdog and 120s hook watchdog, not
per-case arrival or performance budgets. The outer guard leaves cleanup time
after the inner 120s child/scenario watchdog. Explicit events, actual operation termination and durable
state decide correctness. Missing events fail when their producer ends; slow
execution cannot count as an expected refusal. Process release waits native close
after kill/acknowledgement, including cancellation. The scenario's separate 120s
watchdog reports a harness failure, not strict B or a measured security violation;
final evidence is written only after successful resource cleanup.
Execute and inspect share action semantics and observation summaries, so malformed
plans cannot become passing evidence through a different inspection path.

## Module and validation boundaries

[Core](../../../../packages/e2ee-core/README.md) owns protocol primitives and
[Lab](../../../../packages/e2ee-lab/README.md) composes them with released SDKs,
synthetic protection, real SQLite/HTTP and process faults. Lab is not product
assembly or native-keychain acceptance. The [manifest](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/.agents/docs/e2ee-migration-manifest.json)
retains source hashes, dispositions and unfinished work. Author tests, independent
review, exact-head CI and production acceptance remain distinct.

Per-slice progress Notes are removed rather than copied into another archive.
Their fixed history remains at [15d35f75](https://github.com/LodyAI/Lody/tree/15d35f75cd702f9d8846a73f03636ce4afce1d80/.agents/notes).
This consolidation changes no protocol approval or runtime behavior by itself.

## Restored local publication and explicit snapshot consumers

The old local rotation workflow is migrated through a distinct initialized
candidate protector, not an extension of restricted installed-key A. A protected
candidate and original signature are durable and read back before P09 submission.
Lost ACKs and restarts reuse that original; verified commitment and installed
save/reload precede Committed. Explicit ACK retains original history. Publisher
operations do not hold the control actor permit while borrowing installed-key
reads, because those reads refresh the same actor. Full-session operations own
closure, and current-epoch document binding rechecks after asynchronous signing.
The selected staging port retains the complete post-state recipient group and
exact readback gates P09 CAS. Conflicts discard the candidate; unknown outcomes
reuse originals. Recipients verify the genuine committed post-state before
receiving that group, so permanent publisher loss after commitment no longer
requires its disk. This supersedes the old independent publisher-backup options;
vault/native custody remain separate. A manager can still bypass staging and
commit directly, causing a measurable withholding/availability failure.

Ledger/auth snapshot consumers accept an explicitly independently qualified signed origin
and persist only its bytes, genuine suffix and cursor. Every reopen supplies trust
again. The authenticated workspace captures qualification before native auth and
can start reading without the genesis prefix. Offsets and SQL do not select
permission; P09 still verifies full history for writes. This changes no snapshot
wire or qualification rule and does not complete production trust acquisition.

## Current atomic removal and content snapshot completion

The current tag8 operation removes the target and activates the next epoch in one
Owner-personal-signed transition. The original candidate and P09 paths are reused;
retired member/device facts and history remain, while distribution excludes the
removed devices. The existing snapshot auth state already represents that exact
post-state; no old-client capability negotiation or second decoder is introduced.
The encoding remains experimental. Related protocol Specs remain drafts for review;
implementation and tests do not grant approval.

Snapshot content v0 carries a u16be byte length and raw ASCII continuation offset
immediately after the signing public key; the complete field enters signature/AEAD.
Provider header4 is exactly `[4]`. The host checks an actual record boundary no
later than the native head without interpreting opaque caller tokens; readers
compare the exact continuation after decryption. All four document purposes share
the leaf key and retain docEpoch=0. Update content-frame overhead stays 143 bytes;
snapshots add 2+offset byte count. Updates retain exact header3 bytes. Readers reject transplant/model/purpose/signature
and AEAD errors before durable advancement. Host admission binds the authenticated
principal and current writer/epoch before and after native verification. A snapshot
must also retain its admitted original identity and position across retries; raw
Riverrun PUT alone is not that contract. Production retention/trust and strict B
remain separate. The Lab's internal-marked SDK upload method is identified honestly.

Native snapshot retention can make an ordinary read from the beginning return HTTP 410
while the released SDK still recovers from an authenticated snapshot plus suffix.
The Lab preserves this behavior rather than resetting earliest offsets. A read-only
native SQLite observation scans both retained entries and snapshot bodies for
synthetic plaintext; it measures backend storage without assigning ledger authority
or pretending that a pruned prefix remains readable. Three-role Loro/Flock plans
exercise moved-offset refusal, unchanged durable state and actual recovery/reopen.

The remaining active-R→own-personal consumer reuses public proof/P09/HTTP/HPKE
instead of adding a wrapper service. Fresh personal comparison notes still require
an explicit independently obtained exact tuple; a server observation cannot upgrade
itself. A structure assessment recommends keeping domain directories and splitting
only large mixed rotation/receive/distribution owners into pure/workflow/platform.
No files were moved or architecture refactor performed in this migration increment.

## Current creation and reproduction consumers

Client creation persists the one signed genesis before HTTP dispatch. The host
creates that actual first control frame and confirms full signed readback before
publishing its durable floor; it resumes remote-write/local-checkpoint gaps without
re-signing. Reopen still needs an independent minimum. Host observations are not
a client freshness oracle. The registry and P09 retain their existing owners.

Action replay uses fresh OS processes and SQLite owners with the original synthetic
identities, signed/HPKE/ciphertext inputs, prepared candidate/outbox inputs and
native local-edit deltas. Capturing inputs avoids a second core entropy contract;
injecting recorded replies, terminal results or document/cursor post-state would
bypass the crypto/import/persistence behavior being tested and is excluded. Actual
HTTP/P09, SDK import, persistence and cursor commits execute again. Measurements
compare outcomes, exact refusal/fault facts and within-run durable relationships,
without global entropy replacement or fresh-reseal equality. Shrink reproduces
the same concrete failure with original inputs and fresh owners for each candidate.

The private replay directory retains synthetic secret exports and original inputs
with `0700`/`0600` directory/file permissions; public evidence records its binding
digest, not those secrets, and action replay requires the private source directory.
The separate public captured-read pack contains no key: it authenticates/decrypts
original ciphertext only with caller-qualified history and key capability. Bounded
attacker ports exclude honest private paths/keys; missing measurements remain explicit.

The complete Lab host refreshes real control before authorization. Failed persistence keeps a
monotonic observed floor in that object and blocks current/checkpoint and older prefixes until
confirmation; reopen still needs an independent minimum. Offline edits persist native state/old
cursor. The existing SDK seals new work under the current epoch; the same document database retains sealed originals until confirmation so transport retries, including reopen, never reseal. Finite
attack plans receive actual response controls, including allowed header-only mutation;
plans can declare multiple roles and snapshot upload actions. Unrelated or harness failures never substitute
for a measured refusal, and host observations never invent independent comparison confirmation.

## Staging deletion and signature acceptance

Staging is an opaque availability service: an occupied tuple is a client's claim,
not ledger proof. It verifies original record/envelope signatures, immutable bytes
and the caller's device possession. Only the original record signing device can
delete that group, on every cleanup page. Honest clients still verify a genuine
same-epoch competing commitment. Another manager cannot supply its identity or
fabricate occupied to delete the group; the original publisher's own withholding
remains the accepted limitation. Lab storage applies the same opaque boundary
instead of silently giving the server a stronger ledger oracle. Cloud account
authentication requires an additional operation/context-bound device proof.

Both pure and native Ed25519 verification reject identity R before dispatch, in
addition to existing canonical/subgroup/A/scalar checks. A valid cofactored equation
is insufficient; host crypto provider choices must not split ledger acceptance.
The fixed edge vectors run on Node22.x, the supported Node23.6 floor and Node24.x in CI.
The production content gateway still needs a real stream-boundary query capability;
the Lab's native SQLite boundary implementation is not that production API.

## Workspace, vault and desktop round

The user selected vault-v1, per-workspace encrypted R entries plus index CAS, inviter-pinned snapshot joining and desktop-only safeStorage-wrapped KEK custody. Corresponding Specs remain draft for revision approval; product E2EE remains disabled. Web/mobile/CLI custody and strict deadline B are not enabled. The public workspace facade owns common workflows and Lab is its first consumer. Staging deletion checks its original signer and deletes in one transaction; absence succeeds. Streams boundary queries are content blind. Manual model exploration counts replay-confirmed measured violations; benchmarks have no CI thresholds.
