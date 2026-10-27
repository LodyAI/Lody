# PR20-C: epoch reception and send handoff

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1954

[中文](2026-10-27-e2ee-epoch-receive-barrier.zh.md)

## Abstract

M2 stops encrypted sends when the verified epoch changes but cannot resume them.
PR20-C receives committed staging envelopes and hands existing desktop and CLI
rooms to the installed epoch without replacing the Repo or deleting local queues.
A workspace gate retires old provider results, drains actual SDK work, confirms
key installation, replaces sessions and then resumes sealing. Failed steps remain
visible and retryable; revocation and publishing remain PR20-D.

## Authority and sequence

The native workspace owns its verified feed, installed keys and receive journal.
Staging locators come from genuine publication records. KeyReceiver repeats
signature, publication, current-recipient, HPKE and commitment checks. Only a
missing current key enters staging reception. Snapshot-joined devices lacking
the publication original, and later recipients absent from its group, retain
mailbox/history recovery. Server progress never grants authority.

Each renderer/CLI workspace owns one gate and Promise SDK handoff. Epoch changes
or rotationRequired stop new seals synchronously and retire old provider
results. After admitted crypto and actual room I/O settle, current keys are
installed and read back, new providers/sessions start, and sealing resumes. The
content namespace stays bound to genesis across epochs. Core still checks
current authorization on every seal. Old transport callbacks are generation-bound.

Desktop refresh is ledger-only while content sessions exist. A cold device
without a current key can install immediately: it has no old sessions to drain.
The renderer keeps its Repo, mirrors, cursors and pending sends. Explicit retry
and reconnect drive the same finite attempt. CLI local-storage recovery precedes
seal admission, avoiding seal→refresh→barrier→same-seal self-wait. Online callbacks
only request a coalesced refresh, never await a nested transition.

## Actual SDK settlement

Locked streams-crdt 0.19.2 and loro-repo 0.25.0 close subscriptions without joining
all raw work. A real held POST reproduced close returning before upload ended;
the SDK chain also permits late cursor saves. Exact-version pnpm patches add
opt-in drainOnClose; ordinary transports keep its default false.

CRDT retirement stops new admission, retains complete startup/read/direct
operations, including initial-sync tasks detached by their deadline, and waits
those promises plus a stable opQueue tail. Retained SSE release must also settle;
a release timeout fails close visibly and retains its owner for retry. Repo retirement
tracks every created stream, including temporary provisioning, closes admission
before awaiting, and retains removed stream owners until strong close succeeds.
Late session creation is refused. Capability markers refuse protected transports
when either exact-version patch is absent. A private outer workspace must mirror
both patches when it later adopts this public revision; nested patch configuration
is not inherited. Token owners invalidate before close; desktop token cache keys
also include the epoch, preventing reuse if eviction leaves an old row.
Snapshots remain disabled. Versions, wire
algorithms, signatures and persisted formats do not change.

A second ordinary close was rejected as evidence: the old SDK clears session
maps even after failure. Neither timeout nor clearing queues proves raw work
ended. The opt-in close receipt joins that actual work instead.

## Failure containment and migration

- Trigger: verified epoch/rotation change, startup, reconnect or explicit retry.
- Owner: the affected workspace's gate and existing native/transport scopes;
  no network under a global lock, second Repo or independent retry daemon.
- Cancellation: retiring a waiter does not prove its request ended. Gate close
  retires generations and joins admitted work; native scopes retain crypto.
- Handoff: only successful drain, key readback and replacement-session receipts
  reopen sends. Old completions cannot update the successor generation.
- Recovery: drain/install/restart failure remains closed to sends and retries
  on the same owners. Independent workspaces keep sending. Local data and signed
  originals remain; sign-out/quit also close any adapter retained after a failed
  epoch drain before destroying its Repo.

This does not migrate Repo consumers to Effect. Core receive workflows remain
native Effect; the shared Legacy gate composes the existing Promise SDK owners.
The consumer migration remains deferred in the
[roadmap](2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger). No extra
execution runtime, remote signing callback or key export is introduced.

## Evidence and limits

Corresponding fixes are withdrawn for new regression RED runs before GREEN.
Controlled tests cover step retry, old provider and restart results, another
workspace sending during a held handoff, cold missing-key reception, native
SQLite/crypto staging after publisher-scope closure, and real SDK upload, read,
cursor and provisioning settlement. Real Repo/IndexedDB tests additionally prove
that a held protected transport does not block an independent workspace's send.
Focused checks and independent review are bound to the PR head.

Real gateway expiry/long connections, installed two-device rotation, OS
keychains, cross-platform packaging and the total fifteen-minute revocation
bound remain unverified. Complete repository tests belong to CI. This replaces
only M2's send-stop limitation in [its note](2026-10-22-e2ee-m2-product-integration.md),
without approving draft Specs or enabling PR20-D actions.
