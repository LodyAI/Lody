# Ledger records and replay

`@lody/e2ee-core/ledger` provides synchronous Effect 4 Result functions. The root
foundation entry remains unchanged. No runtime, network, CAS, journal, snapshot
endorsement, private key or content cipher is introduced.

```text
caller-pinned genesis + expected (head, length) + raw records
  bounded canonical parsing
  predecessor check + P07-a strict signature verification
  Org/member/kind-bound join or possession proof
  permission from preceding state
  private state transition
  expected endpoint check
  opaque verified view
```

`decodeRecord` returns **unverified** inspection data. `hashRecordBytes` and the
three signing-byte helpers compute bytes, never authority. `verifyLedger` audits
from the caller's independently pinned genesis. `extendLedger` accepts only an
actual view returned by this module, clones its private state, and publishes a new
view only after the entire suffix and checkpoint pass. Failure reports the record
position where available and leaves the earlier view unchanged. Inspections are
detached maps of frozen rows with copy-owning P07-a byte wrappers. Reflected
constructors, structural clones and caller-injected verifiers cannot mint views.

The checkpoint is an independently expected **total** record count and head.
It detects missing suffixes as well as chain breaks and unexpected endpoints. A
server's self-reported endpoint is not an independent freshness proof. This module
does not discover the latest global state, bind product workspace IDs, or resolve
forks; callers own those trust and freshness checks. There is no arbitrary-state
or snapshot starting point in this slice.

Preserved candidate v1 arrays/domains: genesis, admit Member, set role, admit own
device, revoke own device, transfer Owner, publish epoch. Owner/Admin personal
devices may invite and rotate; only Owner personal devices change roles or transfer
Owner. Recovery devices only admit their own personal devices. Revocation affects
only its target, records never create an approval ancestry tree, and Owner retains
a personal/recovery path. Retired signing/encryption keys, member IDs, closed join
requests and epoch commitments remain replay facts. Legacy tag 2 removal is rejected:
it violates the already adopted atomic removal/rotation rule; P12 owns replacement.
No new tag or protocol policy is defined here.

Join `expiresAt` remains a signed nullable field; pure historical replay does not
consult a current wall clock. Online request expiry/admission belongs to a future
host boundary. A valid 72-byte epoch history packet remains opaque; this module
verifies its signed publication and order, not its decryption or key commitment
preimage. Snapshot endorsement, persistent trust restoration, historical author
APIs, delivery, and product integration remain subsequent slices.

[Extraction and reproduced defects](../../../../.agents/notes/implemented/architecture/2026-10-11-e2ee-ledger-records.md)
and [source fingerprints](provenance.json). Run package `typecheck` and `test`;
`test/ledger/replay.test.ts` signs fixed synthetic seeds with native Node Ed25519,
independent of the production verifier, and exercises the public ledger subentry.
