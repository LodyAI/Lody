# Loro 的 WebAssembly 实例 trap 后重启 daemon

Status: implemented
Translation: current

[English](2026-11-09-loro-wasm-heap-exhaustion.md)

## 摘要

一个同时跑 40 到 50 个长会话的 daemon 把 Loro 的 32 位 WebAssembly 堆（4 GiB）写满，约 33 小时内崩了三次。第一次分配失败后，它带着已经损坏的实例又跑了最多 108 秒，记录了数百次 panic，直到 PR poller 一个没有保护的定时器抛出异常，`uncaughtException` 处理器在没有停掉 agent 进程的情况下退出。现在 daemon 把第一次 WebAssembly trap 视为致命错误，走正常关停流程重启，先停 agent 进程；同时定期记录 Loro 堆大小。重启只是限制损失，文档为什么常驻内存由另一项修复处理。

## 决策

`apps/cli/src/lib/loro/wasm-runtime-health.ts` 记录进程里的第一次 WebAssembly 故障。故障是指错误的 cause 链里任何位置出现 `WebAssembly.RuntimeError`，或出现 Loro 的 `loro-crdt: out of WASM memory` / `cannot recursively acquire mutex` 文本。该模块观察 `console.error`（Loro 在 trap 前会在这里打印分配失败）、未处理的 rejection，以及调用 `reportIfWasmFault` 的 catch 点。它自己从不退出。由 `commands/start.ts` 负责处理：调用和 SIGTERM 相同的 `shutdownController.shutdown`，退出码为 1，这样 systemd 的 `Restart=on-failure` 和 Lody watchdog 都会重启 daemon。

PR poller 读取 presence 的地方加了保护，因为它由定时器触发，没有调用方能捕获异常；读取失败时视为"没有人在看"。

`startWasmHeapMonitor` 每 10 分钟以 debug 级别记录一次 `[wasm-heap]`，并在达到 4 GiB 的 75% 和 90% 时各警告一次。此前唯一的内存记录是 `[event-loop]` 延迟日志，它可能几小时才出现一次。

## 发现

- 用 Node 26 上的 `loro-crdt@1.17.0` 复现：Loro 先打印内存不足报告，然后抛出 `RuntimeError: unreachable`。之后，所有当时正在操作中的文档，任何访问都会抛 `RuntimeError: unreachable`，而新建的文档仍然可用。所以实例只是部分损坏，用新文档做探测发现不了。
- 在 Node 26 上，`process.memoryUsage().external` 不包含 WebAssembly 内存，尽管报告者在 Node 22 上的日志看起来包含。因此堆大小从实例的 `WebAssembly.Memory` 读取。开发构建和测试使用的 CJS `nodejs` 入口通过 `__wasm` 暴露它。生产 bundle 使用不暴露它的 `bundler` 入口，所以 bundle（`__LODY_BUNDLED_LORO_WASM__`）会导入 `loro-crdt/bundler/loro_wasm_bg.wasm`。vite-plugin-wasm 只实例化这个模块一次，所以这次导入拿到的是同一块内存。为此，`apps/cli/vite.config.ts` 里的 `loro-crdt` alias 改为只匹配裸模块名。

## 备选方案

- **继续运行，给每个 Loro 调用加保护。** 否决：trap 后受影响的文档一直是坏的，堆也一直是满的，下一次分配还会 trap。只有重启后的状态是确定正常的。
- **在故障处理器里直接退出。** 否决：这正是 `uncaughtException` 的行为，它留下 1,143 个 agent 进程让 systemd 去 SIGKILL。

## 验证

- `apps/cli/src/lib/loro/wasm-runtime-health.test.ts`：故障闩及其各个来源、安装前已记录故障的投递、真实 Loro 内存随文档数据增长，以及堆警告。
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.test.ts`（"keeps polling when a trapped Loro instance…"）：去掉保护时会因未捕获的 `RuntimeError` 失败。
- 用生产 `vite.config.ts` 构建的探针读到共享内存从 1.2 MB 增长到 102 MB。
- 未验证：完整的 daemon 从 OOM 到重启的流程；以及关停期间大量 Loro 调用失败时，7 秒关停预算能否完成。
