# Epoch keys: protocol pieces

Pure epoch-key protocol code, exported through `@lody/e2ee-core/protocol`.
The stateful workflows built on it (`InstalledEpochKeys`, `KeyReceiver`,
`KeyRepair`, `KeyDistributor`, `EpochPublisher`) are described in
[workflows](../../../docs/workflows.md); their rules are in [AGENTS.md](AGENTS.md).

| File | Contents |
| --- | --- |
| `history.ts` | epoch-key commitments, history packets, backward recovery |
| `envelope.ts` | signed HPKE epoch-key envelopes |
| `staging.ts` | staged envelope groups of a rotation |
| `reports.ts` | installation reports, mailbox slots and routing |
| `delivery.ts` | delivery slot id and one put/read-back round |
| `installed-keys.ts`, `receiver.ts`, `repair.ts`, `distributor.ts`, `publisher.ts` | the workflows |

## Commitments and history packets

The current CBOR ledger's fixed v1 commitment and 72-byte history packet.

- `commitEpochKey(genesis, epoch, key)` is SHA-256 over
  `lody-e2ee/epoch-key/v1\0 || genesis32 || uint32be(epoch) || K32` for epoch ≥ 1.
  Epoch zero deliberately uses only the domain and K32; this exception is kept,
  not silently changed. A valid commitment grants no membership or permission.
- `sealHistoryPacket` encrypts K(n−1) under the raw current key with
  XChaCha20-Poly1305 and a fresh host-random nonce, AAD
  `lody-e2ee/epoch-history/v1\0 || genesis32 || uint32be(n)`; the result is
  nonce24 ‖ ciphertext32 ‖ tag16. No nonce override.
- `openHistoryPacket` checks the AEAD only, not the publication or previous
  commitment. It returns an opaque `EpochKey` that owns a copy.
- `recoverLedgerHistory(view, latestKey)` requires a genuine verified view. It
  checks the latest commitment and every backward link and older commitment,
  then returns all epochs or a typed failure, never a partial set. Temporary
  material is wiped on every exit, including a decrypted but wrong previous key.

`EpochKey` values use a private registry and null prototype; reflected symbols
or structural objects cannot export or substitute key material.

## Envelopes

Canonical `AAD || enc32 || ct48 || signature64` under `lody-e2ee/epoch-env/v1\0`.
The expected genesis, epoch, sender and recipient come from the caller; the
frame cannot choose them.

- `authenticateEpochEnvelope` checks current eligibility at a genuine view,
  exact framing and the fixed signature verifier, without decrypting. A host
  must also bind the sender to its authenticated request principal.
- `prepareEpochEnvelope` checks the source commitment before HPKE and signing,
  then re-checks the verified prefix, epoch and device eligibility. Active
  personal and machine devices may forward keys; Recovery devices cannot send.
  Every active recipient kind can receive. Prepare once and keep the bytes.
- `openEpochEnvelope` checks the outer signature before decryption and the
  plaintext commitment and current authority after it. It returns an opaque key,
  not an installation; a failed post-decrypt check wipes the new key.

## Staged groups

`staging.ts` owns the bounded immutable group shape and the genuine-ledger
checks. Every post-transition active device, including Guest and Recovery,
gets a signed frame before the record is appended. The ledger is the single
activation point; an uncommitted group is inert. A different commitment at the
same epoch is the only cleanup condition. Backend rules and wire schemas:
[backend guide](../../../docs/backend-guide.md#3-epoch-staging).

## Reports

`reports.ts` keeps the canonical `key-installed/v1` report bytes: a
recipient-signed claim bound to workspace, epoch commitment, source and repair
revision. It proves neither key persistence nor honest server storage.

## Tests and vectors

`test/keys/*` exercise these pieces through the workflows with real Ed25519,
HPKE and SQLite, child processes and explicit signals. Regenerate the synthetic
history vectors only in an isolated Python environment:

```sh
uv run --no-project --with PyNaCl==1.6.2 python packages/e2ee-core/test/generate-epoch-history-vector.py
```

[Current-format decisions](../../../../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.md#current-format-only).
