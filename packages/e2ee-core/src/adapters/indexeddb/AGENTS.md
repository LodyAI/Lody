# IndexedDB adapters

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Follow the [core rules](../../../AGENTS.md), [ledger rules](../../internal/ledger/AGENTS.md)
and [custody Spec](../../../../../specs/e2ee/client-custody.md).
The [service guide](../../../docs/services.md#browser-ledger-and-original-stores)
explains the public adapter boundary.

- Fixed adapter layouts share native connection/transaction plumbing; ledger and
  custody databases have distinct stable names. Bind each transaction to captured
  account/workspace/genesis; key journals also bind device/installation. A database,
  revision, phase, receipt or counter never supplies authorization.
- Request callbacks stay synchronous. Crypto/network awaits remain outside IDB;
  copy and bound inputs before native work. Verify rows and binding in the same
  transaction, and report success only after complete. Abort/quota never advance state.
- Validate the entire suffix before rebase deletes covered rows. Unknown, missing,
  fractional or malformed records abort while retaining every original and metadata.
- Current installation and retired archive switch atomically, using the approved
  replacement plan and full old binding/revision. Ordinary CAS never changes identity
  or clears retired state. A null slot with residual state is corruption, not first use.
- Retain incoming frames/reports, distribution/outbox, repair, candidate and snapshot
  originals through unknown results and explicit acknowledgement. ACK changes result
  consumption, never authority. At most one epoch candidate is unconsumed.
- Snapshot offsets are opaque. Reserve before native publication, retain the first
  credential window/digest, and select current only after host-confirmed native
  readback. Old Accepted retries cannot rewind current; only the validated prior
  current body may be cleared, preserving its immutable receipt.
- Keep current-only local schemas and validate fixed layouts/indices. Never repair
  corrupt existing state, choose an in-memory fallback or reset a namespace on loss.
  Close fences new requests and drains actual transactions; late open cannot revive it.
