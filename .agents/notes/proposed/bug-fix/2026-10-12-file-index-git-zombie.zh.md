# file-index 扫描返回前须等待两个 Git 列表命令结束

Status: proposed
Translation: current

[English](2026-10-12-file-index-git-zombie.md)

## 摘要

Code Collab 的 file-index 扫描会并行启动两个 `git ls-files` 子进程。第一个失败时，扫描不等第二个结束就直接转入文件系统 fallback；在 Tinypool worker 中，这个未被等待的子进程可能在 macOS 上变成 CLI daemon 名下的 `git` zombie（[#1507](https://github.com/LodyAI/Lody/issues/1507)）。修复保持两个查询并行，但在决定使用 Git 结果或文件系统 fallback 之前，先等两者都 settle。确定性的子进程测试证明了兄弟进程会被等待并回收；macOS zombie 本身是在 issue 中观察到的，未在桌面应用中针对本修改重新复现。

## 问题与证据

- `apps/cli/src/lib/code-collab/file-index-scan-core.ts` 中的 `runGitLsFiles` 使用 `Promise.all([listing, deletedListing])`。listing 调用可能 reject，此时 `Promise.all` 立即结束，而 `git ls-files --deleted` 仍在运行。外层 `catch` 返回 `{ ok: false }`，调用方转入 FS 扫描。
- worker 运行在 Tinypool 中，其默认 `useAtomics: true`。任务 resolve 后，空闲 worker 停在 `Atomics.wait`，其 libuv loop 可能来不及对被遗弃的子进程 `waitpid`，worker 就被销毁。`worker_threads` 的子进程以 daemon 为 PPID，所以 zombie 显示在 `index.js start` 名下（`ps` 记录与隔离复现见 issue）。
- 发布的桌面 bundle 通过 `runCommandTextLegacy` 调用同一函数，因此修复应落在源码函数，而不是 bundle 或 `node_modules`。

## 决策

两个列表命令都改走永不 reject 的 `runGit`，函数在两个子进程都结束后才检查结果。主列表失败仍返回 `{ ok: false }` 并保留 FS fallback；deleted 列表失败仍视为“无需过滤删除项”。扫描架构、Tinypool 选项以及 watcher/ACP/MCP/Electron 代码均不变。

放弃的方案：

- 再加一个 `exit` listener 或回收 hook 无效：子进程没被回收，是因为所属 loop 被挂起，而不是没人监听。
- `useAtomics: false` 会为了掩盖一个未等待的子进程而改变所有任务的池空闲行为。
- 顺序执行两个列表命令同样能等待两者，但会让扫描的 Git 延迟翻倍，且不增加安全性。

## 验证与限制

`apps/cli/src/lib/code-collab/file-index-scan-worker.test.ts` 在 `PATH` 上放置 fake `git`：`--deleted` 调用记录 PID 并阻塞在 FIFO 上；`--cached` 调用在前者运行后才 exit 1。主列表的 rejection 到达扫描核心并经过一个 macrotask 后，扫描必须仍未完成且兄弟进程仍存在；测试终止兄弟进程后，扫描 resolve 为 `null`（FS fallback），且 `kill(pid, 0)` 返回 `ESRCH`，说明子进程既不在运行也不是 zombie。该测试在旧的 `Promise.all` 代码上失败。另一个测试守住成功路径：从工作区删除的路径仍被排除。fixture 依赖 POSIX `sh` 与 `mkfifo`，没有计时器，可在 Linux 和 macOS 上运行，不支持 Windows。

issue 中的生产证据（重启后两个 daemon 名下的 `git` zombie）与这一路径一致；本修改未在打包的 Nightly 上重新验证 zombie 数量。
