# Host identity lifecycle before crypto integration

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1403

[中文](2026-10-10-host-identity-keys.zh.md)

## Abstract

System credential storage does not prove device authorization or hardware execution.
This change proposes insert-only host identity creation, public-key reconciliation
and conservative failures. A real isolated macOS fixture exercises Security storage
and CryptoKit software operations through the interface. Product adapters and
protocol operations remain unconnected; all-platform readiness is not established.

## Decision

Reuse platform and Effect 4.0.2 through a dedicated subpath. The trusted host fixes
personal or machine purpose. Public inspection reconciles an unknown creation
without authorizing a device. No private export, arbitrary signing, deletion or raw
file fallback is exposed. Failures preserve saved material. See the
[draft Spec](../../../../specs/host-identity-keys.md) and
[contract/reproduction guide](../../../../packages/platform/README.md).

```text
trusted host -> purpose-bound store
  create -> insert only -> fresh read -> compare both public keys
  inspect -> existing public keys (uncertain write reconciliation)
  read(expected) -> existing public keys -> reject mismatch
failure / close / cache cleanup -> no deletion
```

A shipping safeStorage/keyring adapter was considered but deferred until protocol,
app signing/ACL and unattended behavior are validated. The Swift implementation is
a test fixture, not product packaging. Apple documents generic-password storage for
Curve25519; Secure Enclave P-256 must not replace Ed25519/X25519. Buffer clearing is
best effort and cannot prove all secret copies erased.

## Evidence and limits

Base `249661be340af5a20b8d0b7334d2e923fe5b5a99`; pnpm 10.20.0; Effect 4.0.2.
macOS 27.0.1 arm64 / Swift 6.4: real isolated lifecycle passed, including separate
identities, fresh-process readback, duplicate rejection, locked read, corruption
preservation, unaffected other identity, exact deletion and missing verification.
Only random-UUID synthetic keys were used; default/search list were unchanged.

Initial sandbox setup returned -50 and cleanup verification failed. Host recheck
returned -25294 (no such keychain), and filesystem inspection confirmed none was
created. The host rerun passed. Early repository checks lacked submodule sources
while initialization was incomplete; an excluded runtime clone failed, and required
root-workspace submodules were subsequently checked out separately.

Protocol signing/envelope opening, scoped private handles and cancellation, screen
lock, human denial, signed app/CLI packaging, upgrades, reboot and unattended policy
remain unaccepted. Windows/Linux, Web/iOS/Android require separate adapters and real
devices. Local body/cache encryption is outside this change.

Final focused verification: platform typecheck and 26 tests passed (12 new lifecycle
cases); the real macOS suite passed separately. `pnpm check:quick`, `pnpm format`
and `pnpm format:check` passed. `pnpm check` passed typechecking/lint, then stopped
at the unchanged CLI Git transport test: 3707 CLI tests passed, one failed with
`context_unreadable`. The same six-test file passed after removing session Git
proxy environment only in its subprocess. This establishes environment interference,
not a full green repository run; later tests in the chain were not completed.
