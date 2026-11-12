# Personal-device client host

[中文](README.zh.md)

`@lody/e2ee-client` is opt-in, platform-neutral product composition over
`@lody/e2ee-core`. It contains no Node, Electron, filesystem, SQLite, default
account or cloud endpoint. Desktop consumes the shared pairing codecs,
full-history verifier and finite key-maintenance owner; its existing native
storage and product assembly remain in place.

## Acquire and own

Build `makeOwnedPersonalDeviceHost(ports)` in a consumer Scope. `ports` is a
resource-owning Layer providing `PersonalHostPlatform`, `PersonalHostRemote`,
`ClientInstallationStore`, `ClientCustodyWriter` and `ClientPairingOriginalStore`.
It acquires those ports and the scoped host in an independently retained Scope. Capture one account/workspace/independently pinned
genesis. A capability captures the same complete binding; another account's login
or a response label never chooses it. Missing support fails explicitly.

The platform supplies persistent custody, ledger ports, key stores/backends,
public approval evidence and optional immutable RPC originals. Browser composition
can use the existing browser-crypto/browser-custody and IndexedDB adapters;
mobile supplies the same narrow custody shape with real native lifetime handling.
Factories receive a borrowed credential valid only in their owning Scope. Their
finalizers must abort/drain actual calls before release. They cannot replace the
host's fixed identity, verifier or installed/candidate protectors through extra
Layer outputs. The host returns neither private keys, credentials nor a generic
signing capability.

- `prepare(offer)` explicitly retains one identity/request before network;
  `begin`, `claim` and `cancel` exchange that exact original. Pending, admitting,
  timeout and generic failure preserve it. Only an exact typed terminal result
  permits a fresh session, preserving the same usable identity and immutable pin.
- `open(offer)` reopens actual wrappers and re-verifies approval and self admission.
  Login, a ready receipt and possession proofs alone never start key reception.
- A session exposes verified ledger reads/refresh, finite key rounds, status,
  document protection, ordinary ledger commands and explicit resume/ACK,
  rotation and closed product RPC preparation/response verification. Commands do
  not silently reconcile a different intent or re-sign an unknown submission.
- `close()` fences admission, interrupts/joins operations, then releases key,
  credential and database owners. Close/logout/cache cleanup never delete identity.
  The composition creates no timer, document Repo or ordinary transport.

## Sealing epoch

New document/Meta/Flock seals select the current verified epoch inside core.
An old caller epoch is only a hint; missing current keys fail for retry rather
than producing new ciphertext at a retained epoch. Already sealed old frames
and historical reads remain valid. A future epoch hint fails until verified catch-up.

## Bounded retirement

Owned host and session `close()` fence new work immediately and share a five-second
budget per actual drain. Timeout reports `PersonalCloseIncomplete` with a narrow
`owner`; retain that complete failure until `owner.awaitSettled()` confirms actual
cleanup. `owner.settled()` reports drain termination, including failure, rather
than proving successful close. No timeout releases a Web Lock, wipes a buffer still
borrowed by native work, deletes identity or permits a replacement handoff.

The caller's Scope uses the same bounded close. The retained owner holds the full
port Layer, native operations and resource Scopes past that caller's lifetime.
Concurrent callers share one drain; metadata creation is serialized separately
from native work. Replacement drains every matching owned reader before invoking
the supplied external-owner drain and the existing atomic identity switch. A closed handle never revives. Successful late settlement lets
a subsequent `close()` confirm cleanup. Keep a runtime entry for that binding
until confirmed close; do not replace it merely because a waiter timed out.

`makePersonalDeviceHost()` remains the lower-level scoped actual-drain constructor.
Product/runtime and mobile-native composition must use the owned constructor;
borrowed external ports must outlive confirmed retirement. The shared runtime below consumes this owner. This package does not select a product
composition or qualify a native mobile implementation.

## Shared platform runtime

`makePersonalWorkspaceRuntime(options)` returns the existing platform
`E2eeWorkspaceRuntime` for one pinned account/workspace/genesis. Construct it inside
an application Scope with the complete resource-owning host Layer, a live account
reader, locally retained offer/original-row readers and the application's Effect
executor. It contains no internal `Effect.run*`, default backend or product selector.
The host checks the same scope independently. The optional creation callback must
be a real creation host; pairing-only composition reports it unsupported.

Runtime open is a control reader lease: it only reopens a ready retained identity,
replays approval and reports verified key availability. It cannot prepare a missing
identity. Shared `RuntimeProvider` opens protected content only when `hasCurrentKey`
or an admitted `writeEpoch` exists; a later retained key can wake that same admission
path. Tokens and content/RPC operations retain their actual core permission/epoch
checks. Ledger status/export stays usable under independent key failure. Exported
local original hashes and absolute positions must occur in the genuine view;
relay pages can only confirm the existing verified feed, never replace its cursor.

`PersonalHostPlatform.contentToken` runs inside the approved session with its
captured device credential and full binding. Product callers receive only dedicated
short-lived content/attachment grants. Rejected tokens, snapshot repair hints and
RPC-only requests are forwarded exactly. RPC methods exist only with the real RPC
original store. Optional `machineSharing` builds a `PersonalMachineSharing` policy
Layer with the fixed identity/scope, verified ledger source and installed-key history;
its real policy owner remains responsible for canonical crypto, durable originals,
generation pins and freshness. Absence omits both sharing methods. No empty handler
advertises personal/member/machine approval or other unsupported product channels.
Ordinary ledger management uses the existing submit/refresh/ACK workflows; member
removal uses atomic remove-and-publish, and rotation resumes retained candidates.

Each open returns an ephemeral `readerOwner`; releasing it spares other readers.
The optional `readerLeases: 'preallocated-v1'` contract accepts a unique caller label
as open's fourth argument, so the provider can fence its pending cold open before
native acquisition returns. A closed queued label cannot publish; closing it cannot
retire another opener or an existing reader. Older desktop hosts keep their current
open/close API and do not advertise this optional contract.
The last reader fences its session immediately. Concurrent close calls share the
owned drain; incomplete close keeps the entry and complete recovery failure, and
reopen confirms actual retirement first. Closing during initial acquisition retires
the whole bound host. Observing a different live account also permanently retires
that assembly; restoring the account cannot revive its handles. The application
creates a fresh assembly only after confirmed retirement of its old owner.
Scope close retains unfinished work through the owned host's bounded close.
Plaintext capture owns cleanup before executor entry, including disposed executors
and failed application Layers. Entry transfers cleanup to the program; rejecting
its caller does not wipe a buffer still borrowed by actual native work. Delayed
execution of a capture already released by its caller is refused.

The shared content bridge has one implementation (`createE2eeContent`, with the
existing desktop import retained). Provider retirement starts renderer cleanup and
native fencing together, preserves failed leases for explicit retry, and cannot
hide a native close timeout by first waiting on the same content operation.
Retirement waits apply only to overlapping custody bindings or Repo namespaces;
an independent ordinary workspace remains usable. Changing device identity still
waits on the same account/workspace/genesis physical writer. Six
security boundaries and browser/React evidence are recorded in the PR; no Web or
mobile product entry is enabled here. [#2075](https://github.com/LodyAI/Lody/issues/2075)
tracks the owned close and bridge adoption together.

## Approval, replacement and failures

Snapshot approval uses the independently transferred endorser and the fixed core
verifier. Full history replays every signature from the independently pinned
genesis. Both must admit the exact personal signing/encryption keys and member.
The protected credential packet also authenticates immutable offer pins. Raw
approval pages and their checksums remain evidence to replay, never authority.

Compositions that supply `PersonalHostRemote.history` qualify a snapshot's earlier
prefix from complete signed originals before claim reports success. The host retains
those public pages in the existing identity/session-bound approval-evidence store;
it replays signatures and checks the original snapshot's head, count and state on
every reopen. Approval originals, snapshot bytes/offset, feed and rollback pins stay
unchanged. An older snapshot installation needs one online qualification when this
capability is first added; subsequent reopens use the saved proof offline. A failed
proof is never saved or treated as permission to reset. Hosts without this optional
capability retain their existing snapshot-only contract.

Control-page continuity checks use the genuine ledger view, including its verified
prefix hashes. Runtime exports merge retained approval originals with the local suffix;
each absolute position is checked against the host's genuine view. When complete
originals are available, the renderer replays them against the same exported head and
state digest when an endorsed snapshot lacks older hashes. Sparse exports
do not invent a prefix. Reset history position only clears renderer
observations; it neither supplies missing proof nor removes the host's durable pin.

`personalLedgerControl({ approval })` composes a persistent `LedgerFeed` over
injected `LedgerFeedStore`, `LedgerPinStore`, `SubmissionJournal`, `LedgerLog`,
`LedgerFeedSource` and `WorkspaceScope`. Keep the feed/pins in a stable database;
use a separate submission slot per incarnation. Refresh is bounded and verifies
every suffix before persisting its position. An installed full-history approval can
reopen offline when the locally re-verified feed already contains its checkpoint.
A valid older prefix must refresh; a conflicting prefix is rejected. The feed receives
both independent pins and the source so an old or corrupt cache can be rebuilt only
after full replay proves its highest checkpoint. Identity, pins and pending journals
are preserved; a cache reset never grants admission.

Explicit `prepare(offer, true)` prepares a wrapped replacement candidate while the
old pointer remains current. A second unresolved candidate is refused. Replacement
opening requires new full-history desktop approval and successful pin/origin
qualification, then actual `drainOld` and the approved atomic retired archive/current
switch. The host retains the first snapshot origin in the new approval original.
On cold reopen its historical manager/signature/state are requalified from the
new signed full history; a cached old label or lost KEK cannot confer trust.
Missing or indeterminate originals require fresh approval, never KEK recreation.

Key acquisition is lazy and independent of ledger ownership. Temporary key/repair
failures remain retryable without sealing the ledger. Status and document sends
may select a valid admitted retained epoch when the current key is missing;
rotation advice does not block permitted sends. Revocation, a changed local
incarnation, rollback or wrong scope still blocks key/RPC/content operations.
For a missing committed epoch, the host first attempts the original staged group
through the core receiver; unavailable staging still permits mailbox reception.
An endorsed snapshot without the publication original uses mailbox/history.
Core retains and verifies receive/report/distribution originals; the shared finite
maintenance owner acknowledges only observed terminal results, including a
successful sibling when another phase failed. There is no plaintext fallback.

## Account-wide pairing workflow

`@lody/e2ee-client/account-pairing` is the shared account-wide personal device pairing
workflow ([foundations Spec](../../specs/e2ee-foundations.md#account-wide-personal-device-pairing-owner-approved-2026-11-01)).
It owns the tag and expiry checks, the single-signature admission journal and local
terminal states. Hosts supply four things:

- an `AccountPairingStore` for durable state, which holds no secret and no private key;
- the relay;
- the per-workspace ports;
- optional `diagnostics`.

The pairing secret stays in memory. The desktop uses a SQLite store; a browser store is
separate work. Identity protection is a per-workspace port decision, never this
workflow's.

`@lody/e2ee-client/account-pairing/browser` adds the browser pieces:

- `makeIndexedDbAccountPairingStore` keeps one account database. Each mutation resolves
  only after its transaction completes, and an abort or quota error advances nothing.
- `makeAccountPairingTabOwnership` with `withAccountPairingTabOwnership` lets only one
  tab own the account's pairing, through Web Locks, because the secret lives only in
  that tab's memory. Other tabs get `pairing-elsewhere`, and a closed tab releases the
  lock.

`@lody/e2ee-client/account-requester` is the portable new-device side:

- **`AccountPairingIdentityHost`** is the per-workspace host port. It prepares or reuses
  this workspace's identity for a verified genesis record and membership, reports an
  unfinished per-workspace join, installs a snapshot invitation for a given endorser,
  optionally installs from verified full history (`acceptAccountHistory`, for rows a
  Member approved without an invitation), and can optionally activate the workspace.
- **`makePortableAccountPairingRequester`** turns such hosts into the shared workflow's
  requester ports:
  - It verifies the full history and finds this account's single membership.
  - On accept, it takes the endorser from the signer of the admission record whose
    ledger hash the approval tag authenticated.
  - It reports an unrelated pending join as `pairing-journal-busy`, which the workflow
    shows as `blocked`.
- **`makePortableAccountPairingApprover`** is the approver side. A device with an
  open, admitted session in a workspace (`session.accountApproval`) can approve there:
  - it signs the personal `AdmitDevice` locally, with no network;
  - it appends the journaled original with the new device's credential hash through
    the injected account-authenticated `appendRecord`, then settles the outcome from
    the verified ledger (committed, lost, or not yet decided);
  - it delivers a signed snapshot invitation as Owner or Admin. A Member gets `null`,
    so its row carries no invitation and the new device verifies the full history;
  - after the admission commits, it starts the session's existing key round in the
    background (`deliverKeys`) so the new device receives the current epoch key, which
    the invitation does not carry. Approval does not wait for it. Each attempt ends
    with mailbox evidence (`keyDeliveryEvidence`); anything short of `delivered` is
    retried on a bounded backoff, and a retry first refreshes the ledger, for at most
    30 seconds, because the mailbox refuses a sender behind it. Each attempt acquires the session, releases it when
    done (so no reader stays open across the backoff), and ends if the session
    belongs to another device (another account); the journal stores the same envelope
    id and bytes. The workflow releases the sessions it listed when it finishes. `onKeyDelivery` reports `running`,
    `retrying`, `delivered` or `ended`;
  - its device access for the relay stays inside this composition.
- **`makeAccountE2eeRuntime`** routes an account's `E2eeWorkspaceRuntime` calls to
  per-workspace runtimes. Only listed methods exist, so capability-by-presence stays
  accurate.

Identity protection comes from each host's platform (`PersonalHostPlatform.protection`).

## Automatic device verification

`./automatic-pairing` owns a ten-minute, current-workspace verification attempt.
A personal device first verifies its retained local identity, then commits its
P-256 ephemeral key and nonce before the new device reveals its own key. Both
devices derive the same six-digit SAS: the new device shows it, and the approver
signs only after the person types a matching code (`approveAutomaticPairing(id,
code)`; the review DTO omits it). The third wrong entry declines the request on
that approver. Lockout never waits for the relay (the hosted client queues mutations
while offline): the native decline is bounded to five seconds, one `declined` write is
kept outstanding, and a failed one is resent on later discovery rounds until delivered
or expired. A restarted approver cannot regain attempts: its new
commitment differs from the relay's frozen first responder, so the request is no
longer approvable anywhere. Separate HKDF labels derive the
128-bit secret used by the existing account request/approval HMAC workflow;
neither private ephemeral keys nor the secret reach the relay. The short code is
for comparison, never a login token or a truncated pairing secret.

The application owns this coordinator independently of content readers. Leaving a
page or choosing Later retains the attempt in that owner; account replacement or
shutdown disposes it. Restart loses the ephemeral secret and requires a new attempt,
while retaining the device identity. The first responding foreground device is
frozen for the attempt; use the help action to cancel and start again with another
device if that responder quits. Transient errors retry exact originals. Approval
means verified admission; the content route still opens its reader and installs the
current key before use. Public relay terminal state cannot grant access.

A renderer reload can lose its automatic exchange while the native account owner
still holds the previous request. Recovery shows that request's workspace names
and expiry, then requires a separate confirmation to end it. Hosts expose the
public `lookupId` only with exact-ID cancellation support. Recovery cancels only
that displayed original, rechecks for a replacement, and requires fresh consent
if another window created one. A completed admission is kept. Older hosts without
this capability require an update or the existing manual route; automatic recovery
never calls unscoped cancellation. Retired advisory discovery rows expire naturally;
the server's indexed cleanup owns erasure, so an unavailable cleanup write cannot
undo native cancellation or prevent a fresh safe request.

See the [pairing decision and protocol review limit](../../.agents/notes/proposed/architecture/2026-11-01-e2ee-account-personal-pairing.md#automatic-current-workspace-verification-2026-11-10).

## Restore from a vault

`prepareVaultRestore` builds a restore plan from an unlocked vault on a device that knows
nothing about the workspace. The genesis comes only from the authenticated package, and
the platform's ports open after that. Core then verifies the ledger, the package checkpoint
and the current-epoch commitment before R admits the new device. No product flow calls it
yet. [Spec](../../specs/e2ee/recovery-vault.md).

## Replace a whole vault

`replaceAccountVault` proves a new R for every workspace before revoking any old R, and
makes the new vault current last. Every step resumes from its own journal, so rerunning is
safe. `abandonVaultReplacement` gives up on the device that started, and
`planVaultReplacement` names workspaces the device cannot act on.
`recoverySubmitOriginal` and `recoveryFetchEnvelope` adapt the service to core.
[Spec](../../specs/e2ee/recovery-vault.md).

## Browser passkeys

`browserPasskeyPort` implements the platform passkey port over `navigator.credentials`.
It reports what the browser returned and decides nothing: a browser without PRF reports
`prfEnabled: false` and no result, and `passkey-unlock` refuses it. Its test runs real
Chromium on the `lody.ai` origin with a CDP virtual authenticator. No page uses it yet.

## Verification and limits

`pnpm --filter @lody/e2ee-client test` runs fixed proof/credential-boundary tests.
`test:browser` uses actual Chromium/WebKit crypto, Web Locks and IndexedDB, including
process reopen, interrupted installation readback, unknown relay results, close,
atomic replacement, retained-epoch sending, revocation and transactional failures.
The portable bundle targets Safari 16.4 with no Node dependency; this does not
establish iOS 16.4 device, native plugin, hardware or power-loss acceptance.
IndexedDB `strict` is a durability hint. Web trusts the code served to the page
with private-key use, as the [approved custody Spec](../../specs/e2ee/client-custody.md)
requires. The runtime factory is opt-in; no product composition is enabled by its export. [Ownership rationale](../../.agents/notes/implemented/architecture/2026-10-16-e2ee-core-service-architecture.md#personal-device-product-composition).

Automatic requests never replace another window's pending native request. Each request fixes its workspace before identity preparation; automatic cancellation and expiry cleanup carry the original lookup ID, so a refused or stale window cannot cancel a different request. Explicit manual cancellation keeps its existing account-wide behavior.

## Vault admission

The host's explicit `restoreRecovery` command authenticates a vault package before
preparing a personal identity, checks its pinned genesis and account membership,
and runs existing R admission with durable originals. It replays signed history
and installs recovered opaque keys through the normal `InstalledEpochKeys`
commitment/protection/readback boundary. Failed installation remains retryable on
the same identity. No signer, private key, R or V is returned. The application owns
vault session lifetime, transports, account guards, entry pins and product rollout.
Recovery remains opt-in; opening an existing identity does not trigger it.

An admitted session exposes explicit `setupRecovery`: signing and installed keys
stay inside its owned boundary, and the result is recoverable only after core's
real recovery test. `restoreRecovery` accepts an exact retained offer for a device
whose protected identity remains but workspace keys are missing; package pins still
must match, and recovery never replaces the identity.

`personalRuntimeAccountRequester` and `personalRuntimeRecovery` adapt the existing
runtime owner for account pairing and closed recovery commands. They do not create a
second host or export private keys. Recovery setup borrows an approved session;
its caller releases only its own reader after completion. Web's optional
`openBrowserRecovery(workspaceId)` opens an in-app surface after personal-computer
consent and returns true only for a ready workspace. It never starts account pairing.
Other-device approval remains a separate choice.
