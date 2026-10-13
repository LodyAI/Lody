# Verify public crypto through the published Streams SDK (P10 preparation)

Status: implemented
Translation: current

PR: [#1433](https://github.com/LodyAI/Lody/pull/1433)

[中文](2026-10-11-e2ee-sdk-preparation.zh.md)

## Abstract

The renderer transport had only reversible protection fixtures, which could not
show that content signatures and authenticated encryption survive its real SDK
boundary. This preparation composes merged public P07 primitives and a P08
synthetic current-author replay through Repo 0.22.0 in the existing transport
suite. Native Ed25519 signing stays entirely in tests; production has no new
entrypoint. Historical-author authorization, production signing custody and
client recovery from a bad snapshot remain missing, so this is not completed P10
or product E2EE acceptance.

## Boundary and evidence

The fixed input is public main `f1ba33a61244e2da07aaea93a30f06227311c4b6`,
including P07-b and P08. [Input fingerprints](../../../../packages/components/tests/workspace-streams-crypto-provenance.json)
identify the actual merged source; no candidate modules or Lab hosts are extracted.
The only dependency addition is a components **devDependency** on the existing
workspace core. Effect remains 4.0.2, Repo 0.22.0, Streams CRDT 0.16.2 and Loro
1.16.3. P07-c crypto and P09 journal directories are outside this change.

```text
synthetic native signer -> public v0 AEAD + signature bytes -> real SDK batch/snapshot
reader's pinned scope + signer -> strict signature -> AEAD -> snapshot position
  -> decompress -> CRDT import -> repo durability -> cursor
```

The test host stores bytes without admitting signatures or granting permission.
The published `encodeStreamsRoomAdditionalData` helper reconstructs actual snapshot
AAD for an independent signature check. A damaged tag is re-signed, establishing
that a valid signature still needs a separate AEAD check. Incorrect Org, logical
document, purpose and epoch fail; metadata cannot create trusted context. A real
secure-randomness failure prevents uploads. Reader failures retain saved content
and the previous cursor; another document continues through the same transport.
Valid compressed snapshots import; bad signatures, authenticated ciphertext
failures and incorrect continuation positions are rejected before decompression.
The fixture uses the public RFC 8032 seed and disposable synthetic data only.

P08's public `verifyLedger` authenticates the fixture's current personal Owner
from a pinned genesis and head/count. Its public `LedgerState.devices` describes
current devices and does not expose the original-author/member-instance mapping
needed after revocation or rejoining. [P08's limits](../../../../packages/e2ee-core/src/ledger/README.md)
explicitly defer historical-author APIs and snapshot trust. [P07-b](../architecture/2026-10-11-e2ee-content-crypto.md)
exposes AEAD only, not a signer or full signed workflow. Importing candidate
ContentCipher/authority/signing hosts would conceal these missing dependencies;
this independently runnable preparation keeps them visible instead.

The existing transport Spec still calls failure scope undecided. This is stale
relative to the adopted single-document behavior: the test demonstrates that a
failure in one document need not stop another, without introducing a new workspace
supervisor or UX. Workspace authorization failure remains separate. No Spec intent
is changed here and no new protocol, recovery format, deadline or UX is chosen.

## Verification and remaining work

Node 22.23.1 and pnpm 10.20.0: transport/cursor tests 43/43 (transport 37,
including 13 new cases), core 85/85, components full suite 556 files/5,076 tests.
Core, components source and owning-test typechecks, scoped type-aware lint, root
formatting, docs with the fixed base, i18n/import/process/platform/public boundaries
and all eight source fingerprints pass. Root `pnpm check` is **not green**:
ordinary sandbox socket/port fixtures fail with EPERM/timeouts. Unchanged
preview/worktree tests pass 33/33 and IPC 9/9 with local-port permission. The
permitted full check passes typecheck/lint; CLI has 3,710 passed, one failed and
four skipped. Its sole failure is the unchanged native Git helper fixture with
`context_unreadable`; direct repetition gives five passed/one failed, and removing
only `GIT_EXEC_PATH` from that test process gives 6/6. Remaining root test groups
are interrupted by this failure; no unrelated implementation/assertion is changed.
The additional owning-test typecheck includes components source ambient declarations;
checking the isolated file without them is not the package's compiler context.

No production signer, historical policy, host snapshot admission, key retrieval,
feature switch, server/cloud/private gitlink or deploy is included. Bad snapshot
**rejection is not recovery**: history/replica selection, replacement, retained
local edits, and continuation after recovery require separate implementation and
acceptance. No nonce or verifier injection is exposed in product code. Resource
ownership and runtimes are unchanged; tests use existing cleanup and fake timers.
The candidate's previously recorded seven core/two Lab failures remain preserved
outside this change; see [P07-b's limits](../architecture/2026-10-11-e2ee-content-crypto.md).
Focused tests and CI are neither independent high-risk review nor production or
all-platform acceptance. The coordinator owns further review and integration.
