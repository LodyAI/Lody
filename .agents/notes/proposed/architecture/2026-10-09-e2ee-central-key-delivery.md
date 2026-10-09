# Central mailbox delivery and installation reporting

Status: proposed
Translation: current

[中文](./2026-10-09-e2ee-central-key-delivery.zh.md)

## Abstract

Offline devices need retained key ciphertext rather than a requirement to be online
when an epoch changes. The public supplement now implements explicit finite delivery
coordination, device-signed installation reports, receive journals and durable result
consumption, with memory/Node stores and a real Lab HTTP host. Exact existing envelopes
and ledger authorization are reused; stored ciphertext and reported installation
remain distinct. Hosted Convex deployment, product scheduling and freshness policy
remain proposed and unverified; a report cannot prove continued key possession.

## Decision and alternatives

The [bilingual draft](../../../../specs/e2ee-central-key-delivery.md) owns intent and
[README](../../../../packages/e2ee-core/README.md) maps the public API. A central
mailbox permits offline/R retention and queryable progress without peer reachability.
The existing Streams adapter is retained; requiring the mailbox to pass through the
key stream would couple storage migration to unrelated permission/content transport.

`Observed` remains exact stored ciphertext readback. Adding a separate signed report
avoids silently redefining existing callers' success semantics. DeliveryId remains
sender correlation, not authority, unique ciphertext identity or a new envelope field.
Server entries aggregate exact digest/sender rows by genesis/epoch/recipient.

The coordinator enumerates its own verified devices, checks its durable current key,
and explicitly resumes existing sendCurrentEpochKey/resumeEpochDelivery machinery.
It reconstructs publication-before-scheduling gaps on startup and handles same-epoch
admissions; other eligible holders may help, while R never forwards. No timer,
background runtime or automatic rebase of signed ledger pending is added.

## Crash consistency and repairs

Client task state and unconsumed terminal result share one atomic document save.
Only explicit application acknowledgement removes a result; a stale concurrent
completion cannot recreate an acknowledged result. Domain failures terminate durably,
transport uncertainty stays pending, storage failure reloads and defects propagate.
No coordinator document lease spans network fan-out.

Receive ordering is: save `verify` context and exact ciphertext, open/verify/commitment
check, checkpoint `install`, keyring.put, queue exact signed report, submit, commit
`done` plus result. A pre-existing local key never replaces verifying new ciphertext.
Restart may use a matching keyring entry only after an `install` checkpoint, otherwise
it reopens the saved envelope. Keyring and receive journal are separate stores; this
ordering closes their crash window without claiming one transaction across them.

Reports bind domain purpose, genesis, epoch, recipient, commitment, source and repair
revision. Envelope sources bind sender/exact digest. Local publication sources require
the exact verified publication record and signing device; genesis uses the same rule.
Snapshot-only journals without the publication record cannot invent local provenance.
Repair requests retain old report history but clear the current reported revision;
late pre-repair reports cannot complete a new repair. Lost-key repair keeps usable
ciphertext, unusable-envelope repair excludes its digest, and a different helper may
repair it. The original sender never replaces its immutable outbox frame; an unusable
saved frame produces a durable `repair-needs-another-sender` failure.

The memory/Node reference stores serialize a bounded 16 MiB document. Node create/open
are explicit and use SQLite EXCLUSIVE leases; missing, foreign and corrupt stores fail
closed. Mailbox ciphertext and derived index share a commit. Queries return at most
100 rows; offset cursors are reference behavior, not stable snapshots. Projection
recovery refreshes verified authority and rejects rollback, retaining exact data.

## Host and Convex boundary

Lab adds opt-in `centralKeyRound()` and an Org-bound authenticated HTTP mailbox.
Its SQLite mailbox is independent of Riverrun control/content. The host verifies
current ledger authority at admission and refreshes after asynchronous signature
checks. This is not an atomic cutoff with the external ledger.

The Spec describes proposed Convex ledgerProjections/keyRecipients/keyEnvelopes/
keyReports/keyRepairs tables, indexed bounded queries and same-mutation index/data
writes. Public core imports no Convex SDK or private routes. A trusted verified-ledger
synchronizer must declare checkpoint, freshness/access window, lag handling and
revocation behavior; a stale projection must not authorize writes.

Prefer the pinned browser-compatible strict noble verifier in the default mutation
runtime. Convex's documented Web Crypto globals are not proof this protocol or bundle
works there. Default-runtime signature/proof/rejection vectors remain a deployment
gate. If a Node action is necessary, the final internal mutation must bind exact bytes
and recheck the current projection; action verification is no durable authorization
proof. Convex and an external Loro Streams permission chain are never described as
one atomic transaction. Content/ledger transport can remain unchanged.

## Evidence and verification limits

- Core's central suite: **17 passed**, real Ed25519/HPKE, explicit failure boundaries,
  duplicate/lost/delayed/old reports, same-epoch devices, helpers, offline R, lost keys,
  bad secrets, revocation/rotation, installed-before-report and no-handler results.
- Three subprocess SIGKILL checkpoints: durable key install, exact report queue and
  terminal-result commit. Fresh processes reopen Node stores and recover/consume.
  This is process-death testing, not hardware power-loss testing.
- Focused core envelope/delivery/central suites: **35 passed**.
- Real Lab HTTP/SQLite/Riverrun central suite: **2 passed**, including host/client
  restart, offline fetch, report status, strict Org credentials and repair impersonation.
  Focused central/history/host suites: **11 passed**.
- Core and Lab typechecks, complete Effect-boundary check and changed-file formatting/
  lint are checked separately. Full suites are **not green**: unrestricted core had
  10 failures (558 passed, 1 skipped); Lab had 2 (185 passed). All failing cases were
  independently reproduced in an unmodified HEAD archive in /tmp: existing review2
  authority/snapshot/sync/outbox/rotation probes and two HTTP snapshot tests. The first
  sandbox core run additionally failed local TCP tests because listening was forbidden.
- Docs check reports unrelated missing ACP-submodule links in the checkout; no SHA
  topics are registered. No hashes were refreshed and no human approval is invented.
- No production deployment, Convex runtime/integration acceptance, protected product
  key storage, formal security proof or global cross-stream freshness is established.

The earlier [Effect migration](./2026-09-22-e2ee-effect-api.md) and
[host gateway](../../implemented/architecture/2026-09-18-e2ee-host-gateway.md) decisions
still apply. This note remains proposed for hosted composition; the public core/Lab
implementation evidence above supersedes its earlier documentation-only assessment.
