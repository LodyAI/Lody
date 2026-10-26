# E2EE IPC and first-sync trial

Run from the public repository root with its frozen workspace dependencies:

```sh
env -u ELECTRON_RUN_AS_NODE apps/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/scripts/e2ee-ipc-benchmark.cjs
```

On another OS, substitute that installation's Electron executable. The entry
creates an isolated OS temporary profile and a local Riverrun server; it does not
start Lody, read a login, or use the OS keychain. Synthetic private keys and the
core document binding stay in main. The renderer forwards encrypted SDK payloads
through IPC. The temporary profile remains available after exit; it contains only
synthetic benchmark data. The 90-second watchdog is a harness bound, not a
performance pass threshold.

The main/renderer import trial uses a 3,000,101-byte native Loro update carrying
three million random hexadecimal characters. Plain/protected writer exports must
match the same update byte for byte before upload. The full first-sync trial uses
two streams on the same real Riverrun instance and streams-crdt 0.19.1. Each sample
creates a fresh IndexedDB database and a fresh SDK/Loro replica, catches up from
HTTP, and atomically commits the native document snapshot and exact SDK cursor in
one IndexedDB transaction. The trial then reads both back and restores the native
document to check durability. Readback and teardown are outside the timed interval.

Twelve plaintext/protected pairs alternate execution order; the first two pairs
are excluded. The first-sync number includes fresh database creation, network,
SDK decoding, main-process decryption over IPC, Loro import and IndexedDB commit.
It excludes React rendering and loro-repo's workspace/directory composition.
The separate 16 KiB seal trial measures 300 native seal/sign/IPC operations after
20 warmups. The artifact reports both median and nearest-rank p95.

Measured on 2026-10-22, darwin arm64, Electron 44.7.0 / Node 24.21.0:

| Operation                      |   Median |      p95 |
| ------------------------------ | -------: | -------: |
| 16 KiB seal + sign + IPC       |  0.60 ms |  0.70 ms |
| 3 MB plain Loro import only    |  4.90 ms |  5.30 ms |
| 3 MB IPC open + Loro import    | 32.10 ms | 33.20 ms |
| Full SDK first sync, plaintext | 44.30 ms | 45.10 ms |
| Full SDK first sync, protected | 71.60 ms | 73.00 ms |

Full first-sync median ratio: **1.6163×**, within the owner-confirmed M2
**1.75×** ceiling. Earlier runs measured 1.6121× and 1.6700×. Both comparison
arms disable snapshot upload and start with **no server snapshot**: each reads
the same native update from the beginning. This is not a comparison between a
plaintext snapshot and encrypted full history. After PR-17 enables encrypted
snapshots, repeat this measurement against the 1.5× goal.

The protected first-sync decomposition below uses the same ciphertext frame
captured from the SDK. Keys remain in main throughout.

| Phase                                        |   Median | Share of protected first sync | Measurement                                                                                      |
| -------------------------------------------- | -------: | ----------------------------: | ------------------------------------------------------------------------------------------------ |
| IPC transfer, serialization and queueing     |  2.22 ms |                          3.1% | Actual provider invoke elapsed minus main binding elapsed                                        |
| Complete native binding                      | 25.68 ms |                         35.9% | Actual main provider call; includes signature/authorship checks, key derivation, AEAD and copies |
| CRDT import                                  |  4.90 ms |                          6.8% | Actual released adapter `applyRemoteUpdates` call                                                |
| Strict signature verification, three passes  | 12.20 ms |           approximately 17.0% | Separate repeated operation on the captured SDK frame                                            |
| Authentication including those verifications | 13.65 ms |           approximately 19.1% | Separate three-pass `authenticateDocument` operation                                             |
| AEAD decrypt                                 | 10.40 ms |           approximately 14.5% | Separate `openContentAead` on the captured frame and same derived native key                     |

The authentication and AEAD rows are **representative phase estimates**, not
additive spans from the timed first-sync call; verification is contained in
authentication, and both are contained in the native binding. The released core
binding authenticates before key lookup, inside `openDocument`, and against the
latest ledger after decryption. Phase trials retain those three checks. They
verify decrypted bytes against the actual binding output, including SDK batch
framing. No alternative cryptographic implementation is measured.

IPC is approximately **3.1%**, below the owner’s approximately 20% trigger, so
batch IPC was not introduced. The remaining elapsed time covers HTTP/SDK work,
IndexedDB creation and atomic document/cursor persistence, plus measurement and
scheduling overhead. Medians of independent phases do not sum exactly.

These local synthetic measurements do not establish whole-product or all-platform
performance. No renderer key export or change to core cryptography was introduced.
