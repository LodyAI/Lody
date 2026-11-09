# Restart the daemon when Loro's WebAssembly instance traps

Status: implemented
Translation: current

[中文](2026-11-09-loro-wasm-heap-exhaustion.zh.md)

## Abstract

A daemon running 40 to 50 long sessions filled Loro's 32-bit WebAssembly heap
(4 GiB) and crashed three times in about 33 hours. After the first failed
allocation it kept running on a broken instance for up to 108 seconds, logging
hundreds of panics, until an unguarded PR-poller timer threw and the
`uncaughtException` handler exited without stopping agent processes. The daemon
now treats the first WebAssembly trap as fatal and restarts through the ordinary
shutdown, which stops agent processes first. It also logs the Loro heap size
periodically. Restarting only bounds the damage; what keeps documents resident
is a separate fix.

## Decision

`apps/cli/src/lib/loro/wasm-runtime-health.ts` latches the first WebAssembly
fault in the process. A fault is a `WebAssembly.RuntimeError` anywhere in an
error's cause chain, or Loro's `loro-crdt: out of WASM memory` /
`cannot recursively acquire mutex` text. The module observes `console.error`
(Loro prints its allocation failure there before trapping), unhandled
rejections, and catch sites that call `reportIfWasmFault`. It never exits.
`commands/start.ts` owns the reaction: it calls the same
`shutdownController.shutdown` path as SIGTERM with exit code 1, so systemd
`Restart=on-failure` and the Lody watchdog both restart the daemon.

The PR poller's presence read is guarded, because it runs from timers with no
caller to catch for it; a failed read now means "nobody viewing".

`startWasmHeapMonitor` logs `[wasm-heap]` at debug level every 10 minutes and
warns once at 75% and 90% of 4 GiB. Before this, the `[event-loop]` lag line was
the only memory record, and it can be hours apart.

## Discoveries

- Reproduced with `loro-crdt@1.17.0` on Node 26: Loro prints the out-of-memory
  report, then throws `RuntimeError: unreachable`. Afterwards every document
  that was mid-operation throws `RuntimeError: unreachable` on any access, while
  a newly created document still works. So the instance is partially poisoned,
  and a probe on a fresh document cannot detect it.
- `process.memoryUsage().external` did not include WebAssembly memory on Node
  26, although the reporter's Node 22 logs suggested it did. The heap size is
  therefore read from the instance's `WebAssembly.Memory`. The CJS `nodejs`
  entry, used by dev builds and tests, exposes it as `__wasm`. The production
  bundle uses the `bundler` entry, which does not, so the bundle
  (`__LODY_BUNDLED_LORO_WASM__`) imports `loro-crdt/bundler/loro_wasm_bg.wasm`.
  vite-plugin-wasm instantiates that module once, so the import sees the same
  memory. This required the `loro-crdt` alias in `apps/cli/vite.config.ts` to
  match the bare specifier only.

## Alternatives

- **Keep running and guard every Loro call.** Rejected: after a trap the
  affected documents stay broken and the heap stays full, so the next
  allocation traps again. A restart is the only state that is known good.
- **Exit directly from the fault handler.** Rejected: that is the
  `uncaughtException` behavior that left 1,143 agent processes for systemd to
  SIGKILL.

## Verification

- `apps/cli/src/lib/loro/wasm-runtime-health.test.ts`: the latch, its sources,
  delivery of a fault recorded before installation, the live Loro memory
  growing with document data, and the heap warnings.
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.test.ts` ("keeps polling when a
  trapped Loro instance…"): fails with an uncaught `RuntimeError` without the
  guard.
- A probe built through the production `vite.config.ts` read the shared memory
  growing from 1.2 MB to 102 MB.
- Not verified: a full daemon OOM-to-restart run, and whether the 7-second
  shutdown budget finishes when many Loro calls fail during teardown.
