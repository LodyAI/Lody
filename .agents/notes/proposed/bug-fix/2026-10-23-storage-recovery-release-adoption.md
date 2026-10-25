# Adopt the released storage recovery fixes

Status: proposed
Type: bug-fix
Translation: current
PR: [#1831](https://github.com/LodyAI/Lody/pull/1831)

[中文](2026-10-23-storage-recovery-release-adoption.zh.md)

## Abstract

Storage failures could repeatedly download already-applied room updates, leave sessions attached to replaced replicas, or prevent IndexedDB from reopening. Lody adopts the reviewed official `@loro-dev/streams-crdt` 0.19.2 and `loro-repo` 0.25.0 releases, and removes its temporary storage-observer patch. The desktop disk-full guard keeps its existing behavior while using the released observer API. This bounds failure amplification and restores recovery; it does not make a full disk writable.

## Release and ownership

- [streams #435](https://github.com/loro-dev/loro-streams/pull/435), released through [#436](https://github.com/loro-dev/loro-streams/pull/436), retains applied progress in memory and retries persistence independently. Live reads and uploads continue during ordinary storage failures. First-sync confirmation still waits for the remote tail; durable cursors never advance past persisted state.
- [Repo #162](https://github.com/loro-dev/loro-repo/pull/162) retires sessions bound to replaced replicas. Its conflict with pending-update persistence was resolved by retaining `unloadDoc`'s evicted-instance return value and preserving main's persistence implementation. [#163](https://github.com/loro-dev/loro-repo/pull/163) reopens browser-closed IndexedDB connections; [#164](https://github.com/loro-dev/loro-repo/pull/164) supplies the native storage write-failure callback.
- Lody pins the two exact releases and adds reviewed release-age exceptions. The 0.24.0 backport patch is removed, with existing native SQLite/IndexedDB integration coverage retained. Other dependencies and the disk-full policy stay under their existing owners.

The original [bandwidth investigation](2026-10-22-streams-persistence-failure-bandwidth.md) and [desktop guard decision](../feature/2026-10-22-desktop-disk-full-guard.md) explain the separate failure paths. This adoption replaces their unreleased-dependency and temporary-patch limitations. The CLI EPIPE fix and disk guard have landed in Lody #1820 and #1829.

## Verification and limits

The combined Repo changes pass type/boundary checks, 723 tests, and package-consumption verification; the conflict-resolution head also passes Linux, macOS and Windows CI. Frozen installation, `pnpm check` in full, formatting and documentation checks pass with the official npm artifacts. CLI passes 4,524 tests and components passes 601 files / 5,976 tests; Electron and the remaining workspace suites also pass. The test process uses system Git to avoid the agent-wrapper fixture issue. No actual full filesystem or reporter-machine reproduction is claimed. Persistence can remain unavailable until the user frees space, and recovery does not imply that unpersisted state survives a process crash.
