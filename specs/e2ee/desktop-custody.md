# Desktop E2EE key custody

Status: draft
Translation: current

[中文](desktop-custody.zh.md)

## Main-process owner

Electron main explicitly creates the core protection capabilities during composition. A random 256-bit KEK is encrypted by real asynchronous safeStorage and stored as a private file. Existing authentication cookie string storage is not reused. No startup hook, IPC route or product E2EE switch is enabled by this module. Web/mobile/CLI custody remains unavailable.

Reject when safeStorage encryption is unavailable. On Linux reject basic_text and unknown/unavailable keyring backends. Never fall back to a plaintext key file. The owner encrypts device signing/encryption private keys, installed epoch payloads and local rotation-candidate payloads with XChaCha20-Poly1305 and fresh secure 24-byte nonces. AAD authenticates each purpose and complete existing Org/recipient/epoch/commitment context; candidate protection additionally binds the original signed candidate. Device protection binds its Org, actual public key pair and personal/machine kind. R secrets never use the persistent device path.

## Persistence and cleanup

Publish complete encrypted files atomically and preserve the first original. Corrupt or incompatible retained files fail without replacement. Reopen decrypts KEK through safeStorage and checks protected key-pair binding. When safeStorage reports `shouldReEncrypt`, rewrap the same KEK, validate the replacement, atomically publish it, then read back and decrypt it again. A SQLite OS mutex covers initialization until native work and recovery settle; a competing initialization fails explicitly. The lock file remains, but the OS releases its lock when the process dies. Before replacing the wrapper, persist a recovery journal containing the exact encrypted old/new wrappers and a one-way digest of the same random KEK. Keep this journal until final verification; a failed rewrap returns `rewrap-failed` and attempts rollback. After process termination or a failed rollback, the next initialization automatically verifies the journal and retained wrapper: keep an already valid replacement; otherwise validate and restore the original. If the old OS wrapping key has retired, validate the journaled replacement against the same KEK digest before publishing and reading it back. A malformed journal or unavailable native decryption fails without generating another KEK or deleting recovery material. No PID, clock, or file-age guess authorizes takeover. This covers process termination, not a guarantee against storage hardware or power-loss failures. Files are private; no plaintext keys are persisted or logged. Scope close rejects new work, waits actual native operations, then clears owned KEK bytes. Native handles and JavaScript strings cannot be promised deterministic zeroization.

## Acceptance boundary

Owning tests use real native crypto/files/OS-child reopen and a synthetic authenticated safeStorage boundary. They verify backend rejection, tamper/AAD rejection, absence of generated secret bytes on disk and actual close waiting. This is not a claim that an OS keychain was exercised. Before product activation, packaged Electron must be verified against actual safeStorage on each supported desktop OS.
