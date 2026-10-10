# Workspace connection lifetime

Status: implemented
Translation: current

[中文](2026-10-10-workspace-connection-lifetime.zh.md)

## Abstract

Connection startup could fail after creating a Repo and listeners, or close could
destroy Repo while an older Web attach still used it. Startup now begins after
its cleanup path exists and failure uses that path. Close cancels token HTTP,
permanently closes existing Effect reconnect loops, and joins attach and Meta
acquisition before destroying Repo. Ordinary storage and Streams protocols stay
unchanged; this does not enable E2EE.

## Ownership and choice

Base: public main `249661be340af5a20b8d0b7334d2e923fe5b5a99`, including
[#1399](https://github.com/LodyAI/Lody/pull/1399). Unchanged dependencies: Effect
4.0.2, loro-repo 0.21.2, Streams CRDT 0.16.2, client 0.9.0, Loro 1.16.3 and
Flock WASM 0.4.3.

- RuntimeProvider retires UI callbacks immediately and aborts unpublished startup.
  Its existing shutdown chain waits for cleanup before opening the next runtime.
- Runtime owns token HTTP cancellation and all Web attach generations until they
  settle. Retired providers cannot publish a gateway or RPC client; late Meta
  acquisitions release their own lease. Existing generation checks still allow
  token replacement without waiting for an older noncancelable attach.
- Reconnect loops keep the existing Effect clocks and retry policy. `stop()` pauses;
  `close()` prevents rearming and joins reconciliation and timer fibers. There is
  no second ManagedRuntime or generic task framework.
- Repo alone owns durable local data. Stores and transports retain their existing
  cleanup; final Repo destruction follows the owned connection work.

```text
retire runtime
  cancel token HTTP and close reconnect loops
  close sends, stores, subscriptions and transports
  join attach generations, Meta acquisition and reconnect work
  destroy Repo through its existing persistence path
```

This extends the [Effect foundation](2026-10-09-effect-v4-migration.md) and
[Streams seam](2026-10-10-workspace-streams-content.md), rather than rewriting the
whole runtime. Noncancelable SDK operations still must settle: there is no new
shutdown deadline and no timeout that destroys a Repo still in use. Held in-memory
sends keep their existing policy; persistence evidence covers committed CRDT edits.

## Evidence and limits

The lifecycle, provider, reconnect and Streams factory suites cover failed local
attachment cleanup, cancelled real token-provider HTTP, late auth/attach/Meta,
repeated close, account replacement and existing rotation/retry behavior. A real
loro-repo and IndexedDBStorageAdaptor over fake-indexeddb reopen an offline local
commit after disposal without an explicit flush or remote acknowledgement.

The [contract](../../../../specs/workspace-runtime-lifecycle.md) is draft. Stream
IDs, storage namespaces, snapshots, cursor code and dependency versions do not
change. No keys, persistent mode fields, cryptography, platform key storage,
deployment or installed cross-platform acceptance are included. Promise workflows
outside this selected connection group remain separate work.

Local validation: the focused four suites pass 89 tests; the components suite
passes 5042 tests in 556 files. Repository typecheck/lint, boundary guards,
format checks and docs check pass. `pnpm check` stops at sandbox `listen EPERM`
in two unchanged shared IPC suites; those pass outside the sandbox (14 tests).
The remaining packages were checked separately. CLI has 3707 passes and one
Git-helper environment failure; its entire affected file passes all six tests
when only that test process uses system Git without inherited `GIT_EXEC_PATH`.
Electron passes 215 tests, UI 299, and turn-diff-store 31. This is split
validation after environment failures, not a successful uninterrupted `pnpm check`.
