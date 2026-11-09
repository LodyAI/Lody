# Keep Loro's WebAssembly heap bounded, and restart when it traps

Status: implemented
Translation: current

[中文](2026-11-09-loro-wasm-heap-exhaustion.zh.md)

## Abstract

A daemon running 40 to 50 long sessions filled Loro's 32-bit WebAssembly heap
(4 GiB) and crashed three times in about 33 hours. Documents stayed loaded for
days because only sessions with turn tracking were ever collected, while MCP
reads, parent-owner lookups and other readers adopted docs into the same cache.
After the first failed allocation the daemon kept running on a broken instance
until an unguarded timer threw, and it exited without stopping agent processes.
Idle GC now covers every cached Session doc, the sweep turns aggressive near the
heap limit, and the first WebAssembly trap restarts the daemon through the
ordinary shutdown. Loro's own memory retention is unchanged, so a single very
active workload can still reach the limit.

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

Every `getOrCreateSessionDoc` caller adopts the doc into
`LoroDocumentManager.sessions`, but GC took its candidates from
`MessageHandler`'s turn-tracking store only. Same-machine MCP reads
(`lody_session_list` reads up to 100 sessions), owner lookups in
`turn-post-processing-service.ts` and `workspace-git-service.ts`, schedules,
automations and previews therefore loaded docs that nothing unloaded until
restart. `combineGCSessionSources` now makes every cached doc a candidate. A
tracked session keeps its turn-activity clock, so a reader polling its doc
cannot keep its agent process alive. An untracked doc is idle from its last
hand-out and unloads with `preserveStatus`, because it never ran a turn here.
GC's own goal check peeks at the cache, since opening would count as an access.

The idle sweep also reads the heap size. Past 3 GiB it collects sessions idle
for 2 minutes instead of 20, with the same eligibility checks. WebAssembly
memory never shrinks, so this mode lasts until restart.

Opening and releasing a cached doc logs the cache size at debug level, and an
open names its caller.

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

- **Read same-machine Sessions transiently in MCP.** Rejected for now: each read
  would re-import a snapshot of up to 80 MiB, and `lody_session_list` reads up
  to 100 Sessions per call. Caching with idle collection keeps polling cheap.
- **A byte cap on loaded documents.** Not possible yet: neither Loro nor the
  WebAssembly memory reports live allocation, only the high-water size.
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
- `apps/cli/tests/loro-doc-unload-data-plane-integration.test.ts` ("idle GC
  unloads Session docs that only a reader cached…"): a real manager and GC
  unload a reader-cached doc by its last hand-out. It fails when candidates
  come only from tracked sessions.
- `apps/cli/src/lib/session-gc-manager.test.ts` ("shortens the idle timeout…").
- Daemon reproduction (isolated `LODY_DATA_DIR`/`HOME`, dev build, local
  platform): four seeded Sessions with pending turns were dispatched to the
  managed Claude runtime (nine child processes). A `--import` preload then
  reserved the daemon's own Loro address space with untouched
  `__wbindgen_malloc` blocks (little RSS) until an allocation failed, and
  exported each daemon document so it trapped while holding its locks, as in
  crash 3. With this change the daemon logged the fault, ran the SIGTERM
  shutdown sequence, met `RuntimeError: unreachable` in ACP flushes and history
  finalization, force-terminated the agents and exited with code 1 in 0.8
  seconds with no surviving child. A build of `main` was still running 120
  seconds after the same fault, with every agent process alive.
- Not verified: a real 4 GiB heap filled by document data (this machine cannot
  hold it), the uncaught-exception exit that ended the reported crashes, and
  how much idle collection lowers the heap of a long-running busy daemon.
