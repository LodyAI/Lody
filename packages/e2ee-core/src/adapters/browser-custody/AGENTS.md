# Browser custody

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Follow the [core rules](../../../AGENTS.md) and the approved
[client custody Spec](../../../../../specs/e2ee/client-custody.md).
Implementation and ownership: [services](../../../docs/services.md#browser-custody-and-installation).

- Keep the fixed five-purpose DAG-CBOR AAD and v1 wrapper bytes. Never expose a
  production KEK import/export, nonce override, alternate verifier or plaintext fallback.
- Web Locks bind the origin's account/workspace/genesis scope. Enter the writer
  before identity allocation; hold it through actual local/native settlement and
  release before network. Busy returns conflict; never steal or infer termination
  from cancellation or a deadline. Only the holding fiber may reenter; inherited
  child-fiber context never lends physical ownership. Close fences admission and drains admitted work.
- Persist creation intent before generating the non-extractable AES-GCM key.
  Marker/key/probe and actual key readback establish protection only. Probe native
  write/readback/restore before reporting availability; missing halves never initialize.
  Before creation intent, reject any retained protection/original for that full
  incarnation in the same transaction, including when marker and key are both absent.
- Complete fallible availability checks before committing a wrapping intent. After
  nonce/intent commit, retain ownership through actual encryption/ciphertext settlement
  without an interruption gap. Pre-encryption probe/transaction failures remain retryable.
  Reserve each random nonce durably before encryption and retain its record.
  Validate nonce count and probe membership across reopen; a missing ledger blocks.
  Completed wrapping originals win. Unknown intents never re-encrypt; only the same
  operation's retained ciphertext may retry its commit. Never await crypto inside IDB.
- Identity wrappers and receipts remain untrusted. Reopen verifies real unwrap,
  signing/encryption key pairs, credential and current host admission separately.
  Scope close/logout/cache cleanup retain keys and originals. Delete is an explicit
  host-authorized scoped operation and must spare replacement incarnations.
- Browser-engine persistence and strict durability hints do not prove iOS 16.4
  real-device, power-loss, profile-copy resistance or production acceptance.
