# Current-epoch preference and bounded key-reception grace

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2131
Owner revision: 2026-10-31

[中文](2026-10-27-e2ee-epoch-receive-barrier.zh.md)

## Abstract

Every new content seal prefers the verified current epoch inside the host, regardless of a renderer's cached hint. When that key is genuinely missing, the owner's 2026-10-31 revision accepts at most fifteen minutes of delayed confidentiality enforcement from each device’s first verified observation to preserve availability and backend cost. During that bounded window the newest available retained, published epoch key may encrypt new content. A revoked device retaining that old key can read those frames; backend credential expiry or epoch checks do not establish confidentiality during this accepted window.

## Decision and retained bug fix

The owner revises #2131's strict refusal while a current key is missing, not its stale-renderer bug fix. A current installed key always wins over an old provider hint. Desktop native, CLI and portable/browser document bindings share core's `writeEpoch: current` selector, covering document, Meta and Flock updates and snapshots. RPC/execution admission remains separate and unchanged. No backend epoch enforcement, new network request, replacement key, plaintext fallback or online format change is introduced.

Only an actual installed-key `missing-key` result permits trying the newest available older key. Its publication and commitment must belong to the same genuine ledger. Storage, protection, commitment and permission failures never become missing-key success. Core repeats current member/device permission checks before encryption and after signing; removed/revoked devices, Guest and Recovery writers gain no authority. The selector checks current installation again after opening an old candidate, so a concurrently installed current key wins before encryption.

An operation already capturing its epoch before later publication may finish, and already sealed queued frames retain their original bytes. Historical opening stays independent of new-write eligibility. Status may continue to advertise a retained readable epoch after grace expires; it does not authorize a new seal or close the workspace's local history.

## Device-local deadline and persistence

`VerifiedLedger` records the first genuine observation of each published epoch in the optional local `LedgerPinStore.writeGrace` CAS journal. SQLite uses a bounded additive metadata table in the existing genesis-bound pin file; IndexedDB uses a separate key in its existing bound metadata store. No ledger, content, key-wrapper or wire version changes. Observation is persisted before pin advancement; unknown or failed timing persistence denies fallback without breaking genuine ledger reads or current-key writes.

For an older key, the earliest observed newer publication starts its budget. A later rotation cannot renew that key's window. Injected Effect Clock wall and monotonic samples are compared with durable first samples and elapsed high-water marks. Regressing either clock exhausts the budget. Missing/corrupt metadata for already pinned state, CAS/storage failure, or unknown monotonic continuity refuses the grace. Closing/reopening a host with the same clock preserves its original deadline; a new process/page/clock domain conservatively expires remaining grace rather than guessing elapsed time or granting a fresh window. Default monotonic clocks may differ in suspend behavior; wall elapsed is also charged. This is a device-local policy under the existing non-malicious-local-OS/storage threat boundary; it cannot establish global publication freshness or resist an attacker controlling host time/storage.

At elapsed time **>= 900,000 ms**, a missing current key produces retryable `key-update-required`; the deadline is checked again after signing before returning a retained frame. The SDK keeps local edits and retries through its existing owner. Successful fallback during grace starts no missing-key notice. Only that explicit failed-seal signal starts #2138's thirty-second workspace notice; unrelated I/O failures do not. Installation clears the notice through existing transition phases; a resumed successful save also clears the failed-save episode without starting reception. Receipt requests, retry ownership, token invalidation and close/drain behavior remain unchanged; save never waits for network key reception.

## Evidence and limits

The owning core crypto suite uses genuine signed ledgers, real SQLite and injected clocks for update/snapshot frames, exact expiry, host reopen, new clock domains, rollback, missing metadata and immediate current-key preference. CLI and native desktop suites exercise their actual storage/crypto bindings. The portable host suite uses real browser IndexedDB and custody. Component tests connect the explicit deadline failure to the delayed nonblocking notice and installation clearing. These are local deterministic boundary checks, not packaged desktop, OS keychain, WAN, suspend/resume or real-device acceptance.

Reception still verifies signatures, publication, recipient, HPKE and commitment independently; optional staging failure cannot block valid mailbox receipt. Earlier reception/selection choices are documented in [#1954](https://github.com/LodyAI/Lody/pull/1954), and advisory permission changes in [#1956](https://github.com/LodyAI/Lody/pull/1956). The native Effect consumer migration stays in the [roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger).
