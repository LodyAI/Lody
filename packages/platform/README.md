# Platform contracts

This package contains platform-neutral composition contracts. `./host-keys` adds
an unconnected host identity lifecycle seam using the workspace's Effect version.
It does not enable encrypted workspaces or register IPC handlers.

`makeHostIdentityStore(purpose, backend)` fixes the identity purpose in trusted
host composition. CLI callers may receive only a machine store. Account/device
references come from that host, not an envelope or renderer's assertion. This
separation is an assembly rule, not an OS isolation claim against a compromised host.

Create is insert-only and succeeds after a fresh read verifies both public keys.
Read requires the expected public identity and never creates or repairs a key.
Inspect discovers only existing public keys after an uncertain create; discovery
does not enroll a device or grant authority.
Errors contain fixed categories and optional numeric native status, not raw
messages or private material. Ambiguous native authentication/decode failures
retain `reason: unknown`. A failed or interrupted creation may have committed:
reconcile the same reference before any further action. There is no automatic
retry, replacement, deletion, private-key export or arbitrary signing operation.

No private handle is retained by this first interface. Purpose-specific signing,
envelope opening, scoped handle invalidation, lock-screen cancellation, and recovery
remain dependent on the reviewed crypto contracts and later host adapters. Key
storage must live independently of ordinary caches and logout cleanup.

## Validation

```sh
pnpm --filter @lody/platform test
# Explicit opt-in on macOS with the existing Xcode command-line tools:
LODY_TEST_HOST_KEYS_MACOS=1 pnpm --filter @lody/platform test test/host-keys.macos.test.ts --maxWorkers=1
```

The native fixture generates a random UUID and an isolated temporary file
keychain. All queries include that keychain, UUID service and fixed synthetic
account/device/purpose. It never reads existing user items or changes the default
keychain/search list. UI is forbidden in each child process. Cleanup deletes only
its two known items, verifies missing, then deletes the fixture keychain; failure
retains the path for explicit recovery and fails the suite. A timeout, signal or
spawn error is always failure even with exit zero.

The fixture stores Ed25519/X25519 bytes with Security, restores them into CryptoKit
software memory and runs only a fixed internal self-test. Only public keys leave
the child. This is **not a shipping macOS adapter or a hardware execution claim**.
Swift's best-effort buffer clearing does not prove all private memory copies erased.
Apple documents [Curve25519 storage as generic passwords](https://developer.apple.com/documentation/cryptokit/storing-cryptokit-keys-in-the-keychain)
and [the Secure Enclave P-256 boundary](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave).

The file-keychain fixture does not validate app entitlements, signed Electron/CLI
packaging, screen lock, a human denying access, upgrades or unattended operation.
Windows/Linux stores and actual Web/iOS/Android devices need separate adapters and
validation; none inherit this macOS result. All-platform Beta remains unaccepted.
