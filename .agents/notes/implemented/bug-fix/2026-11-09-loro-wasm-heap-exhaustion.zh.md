# 控制 Loro WebAssembly 堆的上限，trap 后重启

Status: implemented
Translation: current

[English](2026-11-09-loro-wasm-heap-exhaustion.md)

## 摘要

一个同时跑 40 到 50 个长会话的 daemon 把 Loro 的 32 位 WebAssembly 堆（4 GiB）写满，约 33 小时内崩了三次。文档会在内存里留好几天：只有带轮次跟踪的会话才会被回收，而 MCP 读取、父会话查询和其他读取方也会把文档放进同一个缓存。第一次分配失败后，daemon 带着已经损坏的实例继续运行，直到一个没有保护的定时器抛出异常，然后在没有停掉 agent 进程的情况下退出。现在空闲 GC 覆盖所有缓存的 Session 文档；堆接近上限时回收变得更激进；第一次 WebAssembly trap 会走正常关停流程重启 daemon。Loro 自身的内存保留没有改变，所以单个非常活跃的工作负载仍可能触顶。

## 决策

`apps/cli/src/lib/loro/wasm-runtime-health.ts` 记录进程里的第一次 WebAssembly 故障。故障是指错误的 cause 链里任何位置出现 `WebAssembly.RuntimeError`，或出现 Loro 的 `loro-crdt: out of WASM memory` / `cannot recursively acquire mutex` 文本。该模块观察 `console.error`（Loro 在 trap 前会在这里打印分配失败）、未处理的 rejection，以及调用 `reportIfWasmFault` 的 catch 点。它自己从不退出。由 `commands/start.ts` 负责处理：调用和 SIGTERM 相同的 `shutdownController.shutdown`，退出码为 1，这样 systemd 的 `Restart=on-failure` 和 Lody watchdog 都会重启 daemon。

PR poller 读取 presence 的地方加了保护，因为它由定时器触发，没有调用方能捕获异常；读取失败时视为"没有人在看"。

`startWasmHeapMonitor` 每 10 分钟以 debug 级别记录一次 `[wasm-heap]`，并在达到 4 GiB 的 75% 和 90% 时各警告一次。此前唯一的内存记录是 `[event-loop]` 延迟日志，它可能几小时才出现一次。

每个 `getOrCreateSessionDoc` 调用方都会把文档放进 `LoroDocumentManager.sessions`，但 GC 只从 `MessageHandler` 的轮次跟踪表里取候选。所以本机 MCP 读取（`lody_session_list` 一次最多读 100 个会话）、`turn-post-processing-service.ts` 和 `workspace-git-service.ts` 里的父会话查询、定时任务、自动化和预览加载的文档，在重启前都不会被卸载。现在 `combineGCSessionSources` 让每个缓存文档都成为候选。被跟踪的会话继续用轮次活动时间计时，所以反复读取它的文档不会让它的 agent 进程一直存活。未被跟踪的文档从最后一次交给调用方的时间开始计算空闲，卸载时使用 `preserveStatus`，因为它从未在本机执行过轮次。GC 自己检查 goal 时只查看缓存，因为打开文档会被算作一次访问。

空闲清理也会读取堆大小。超过 3 GiB 后，它回收空闲 2 分钟（而不是 20 分钟）的会话，其他资格判断不变。WebAssembly 内存不会缩小，所以这个模式会持续到重启。

打开和释放缓存文档时会以 debug 级别记录缓存大小，打开时还会记录调用方。

## 发现

- 用 Node 26 上的 `loro-crdt@1.17.0` 复现：Loro 先打印内存不足报告，然后抛出 `RuntimeError: unreachable`。之后，所有当时正在操作中的文档，任何访问都会抛 `RuntimeError: unreachable`，而新建的文档仍然可用。所以实例只是部分损坏，用新文档做探测发现不了。
- 在 Node 26 上，`process.memoryUsage().external` 不包含 WebAssembly 内存，尽管报告者在 Node 22 上的日志看起来包含。因此堆大小从实例的 `WebAssembly.Memory` 读取。开发构建和测试使用的 CJS `nodejs` 入口通过 `__wasm` 暴露它。生产 bundle 使用不暴露它的 `bundler` 入口，所以 bundle（`__LODY_BUNDLED_LORO_WASM__`）会导入 `loro-crdt/bundler/loro_wasm_bg.wasm`。vite-plugin-wasm 只实例化这个模块一次，所以这次导入拿到的是同一块内存。为此，`apps/cli/vite.config.ts` 里的 `loro-crdt` alias 改为只匹配裸模块名。

## 备选方案

- **MCP 对本机会话改用临时读取。** 暂不采用：每次读取都要重新导入最大 80 MiB 的快照，而 `lody_session_list` 每次最多读 100 个会话。缓存加空闲回收能让轮询保持低成本。
- **给已加载文档的总字节数设上限。** 目前做不到：Loro 和 WebAssembly 内存都不报告实际占用，只有高水位大小。
- **继续运行，给每个 Loro 调用加保护。** 否决：trap 后受影响的文档一直是坏的，堆也一直是满的，下一次分配还会 trap。只有重启后的状态是确定正常的。
- **在故障处理器里直接退出。** 否决：这正是 `uncaughtException` 的行为，它留下 1,143 个 agent 进程让 systemd 去 SIGKILL。

## 验证

- `apps/cli/src/lib/loro/wasm-runtime-health.test.ts`：故障闩及其各个来源、安装前已记录故障的投递、真实 Loro 内存随文档数据增长，以及堆警告。
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.test.ts`（"keeps polling when a trapped Loro instance…"）：去掉保护时会因未捕获的 `RuntimeError` 失败。
- 用生产 `vite.config.ts` 构建的探针读到共享内存从 1.2 MB 增长到 102 MB。
- `apps/cli/tests/loro-doc-unload-data-plane-integration.test.ts`（"idle GC unloads Session docs that only a reader cached…"）：用真实的 manager 和 GC，按最后交付时间卸载读取方缓存的文档。如果候选只来自被跟踪的会话，测试会失败。
- `apps/cli/src/lib/session-gc-manager.test.ts`（"shortens the idle timeout…"）。
- daemon 复现（独立的 `LODY_DATA_DIR`/`HOME`、dev 构建、本地模式）：预先写入 4 个带待执行消息的会话，daemon 把它们派发给托管的 Claude 运行时，共 9 个子进程。然后用 `--import` 预加载脚本，以不写入的 `__wbindgen_malloc` 大块占满 daemon 自己的 Loro 地址空间（RSS 几乎不涨），直到分配失败；再导出 daemon 的每个文档，让它们在持锁时 trap，和第 3 次崩溃一样。有这项修改时，daemon 记录故障，走 SIGTERM 的关停流程，在 ACP flush 和历史收尾时遇到 `RuntimeError: unreachable`，强制终止 agent，0.8 秒内以退出码 1 退出，没有子进程残留。同样的故障下，`main` 的构建 120 秒后仍在运行，所有 agent 进程都还活着。
- 未验证：真正由文档数据写满 4 GiB 的堆（这台机器内存放不下）；报告中那几次崩溃最终经由未捕获异常退出的路径；以及空闲回收能把一个长期运行的繁忙 daemon 的堆降低多少。
