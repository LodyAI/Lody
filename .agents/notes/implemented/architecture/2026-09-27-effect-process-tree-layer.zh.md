# 通过统一的 Effect 进程层终止 ACP 进程树

Status: implemented
Translation: current
PR: [#1065](https://github.com/LodyAI/Lody/pull/1065)

[English](2026-09-27-effect-process-tree-layer.md)

## 摘要

CLI 里至少有五份手写的"SIGTERM、等待、SIGKILL"，细节各不相同：有的等待没有上限，有的计时器
不清除，有的忽略被信号杀死的进程，还有一份吞掉 sandbox 失败却仍报告会话已终止。ACP 包装进程
先退出后，它留下的后代不会再被发任何信号；Windows 上只杀掉外层包装。本变更实现了
[自底向上 Effect 迁移](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md)
的最下面两层：OS 边界上唯一的 `NodeProcess` 服务，存活判断覆盖全部成员的进程树，以及统一的
有上限终止策略——失败时返回类型化错误，而不是卡住或假装成功。会话 agent、终端命令、能力探测 /
标题 / 登录 agent、历史 agent 与登录状态探测现在都经由它结束。父进程已先退出的 Windows 后代
仍然无法触及，因此 [#429](https://github.com/LodyAI/Lody/issues/429) 只解决了一部分；
本次验证不包含真实 provider 或 Windows 运行。

## 范围

这是 [Turn 执行与 ACP 进程所有权计划](../../proposed/architecture/2026-09-27-effect-turn-execution-and-acp-process-ownership.zh.md)
的 PR1：L0 平台层加 L1 进程叶子层，覆盖所有与 ACP 相关的进程——会话 sandbox（ACP agent、`exec`
命令、ACP 终端）、经 `spawnAcpProcess` 启动的辅助 agent（能力探测、标题生成、协议登录、历史
目录），以及内建登录状态探测。git、worktree setup runner 等其他 spawn 调用方在下一个 PR 迁到
同一个服务上。

`Session`、`TerminalManager` 与辅助调用方仍是 Promise 代码，通过临时门面（`session-sandbox.ts`、
`terminateAcpProcessTree`）使用 Effect 层；门面登记在
[cli-effect-ts](../../../docs/cli-effect-ts.md#temporary-promise-facades)，在各自所在层迁移时删除。

## 决定

**统一的树抽象，按整棵树判断存活。** `ProcessTree` 的 `isAlive` 对所有成员作答（POSIX 进程组用
`kill(-pgid, 0)`，cgroup 读 `cgroup.procs`），`signal` 送达所有成员。`terminateTree` 的流程是：
检查存活、SIGTERM、有上限的宽限期、SIGKILL、有上限的等待。由于存活不看根进程的退出事件，npx 或
shell 包装先退出、它启动的 agent 仍在运行时，终止照样继续。真实进程测试覆盖了这种情况：leader
退出后留下的 `sleep` 孙进程被杀掉。

**失败带类型，处理方式取决于调用方。** 无法证明整棵树已消失时，终止以 `TerminationFailed`
（`still-alive` 或 `signal-failed`）失败。`Session.terminate` 仍会清空引用并发出 `terminated`，
保持原有的生命周期记账，但现在会以该错误 reject；这样会话规则"drain，或确认已终止"不会再把残留
进程当成空闲 agent。辅助 agent 从不复用，因此 `shutdownLocalAcpAgent` 以 `warn` 记录失败并正常
返回：这些调用方在 `finally` 里关停，reject 会丢掉已经成功的能力探测结果或生成的标题。

**`Session.terminate` 合并并发调用。** 并发调用共享同一次终止，`terminated` 只发一次，事件里的
退出码改为 agent 的，而不是最后一次 `exec` 命令的。有进程树未能终止的会话状态为 `failed`，
而不是 `terminated`。

**进程组比 leader 活得久。** 无限制容器会一直跟踪一个进程组，直到它为空，leader 已退出也不例外；
对这种残留组每 5 秒探测一次，确认为空后才移除。组内还有成员时内核不会复用该组 id，因此复用窗口
最多只有一个探测间隔。另一种做法是 leader 一退出就杀掉组内剩余成员，但 ACP 终端命令可以合理地
留下后台任务直到 Session 结束，所以没有采用。

**Linux 上 sandbox 进程也各自成组。** 以前 cgroup sandbox 让子进程留在 daemon 的进程组里，
单个进程的终止只杀根进程。现在它们同样以 `detached` 启动，终止单个终端命令能触及其整棵子树，
而不必用 `cgroup.kill` 结束整个 Session。

**Windows 有上限，但不完整。** `taskkill /T` 在 10 秒期限内运行，并检查退出码：128 表示"已不存在"，
其他非零值视为失败。如果温和的 `taskkill` 被拒绝（只能强制终止的控制台进程就是这样），就直接改用
`/F`，不再等宽限期。父进程已先退出的后代从根进程出发已无法触及，只有 Job Object 能把它们收住，
这留给单独的变更处理。

**监听器在 spawn 的同一个同步步骤中挂上。** 测试发现，如果 `taskkill` 在 `close` 监听器挂上之前
就结束了，终止会一直等到期限用完。现在 spawn 在任何 fiber 可能让出之前，就挂好 `exit`、`error`、
`spawn` 事件以及调用方的 `onSpawned` hook。

**与计划的偏差：暂不引入守护进程运行时。** 提案把守护进程级 `ManagedRuntime` 放在 PR1，但本 PR 里
没有任何资源的生命周期与守护进程相同：每个进程都属于某个 Session 或某一次调用。因此门面按调用
提供 Layer；守护进程运行时随 L4 引入，那里的会话池是第一个守护进程级的拥有者。现在就把 turn fiber
迁到守护进程作用域，会在下层完成之前先改动 L5。

## 后续：CLI 中所有进程调用方（[#1069](https://github.com/LodyAI/Lody/pull/1069)）

下一个叠加的 PR 把 `apps/cli/src` 中其余所有进程调用方迁到这一层——git 与 gh 调用、daemon /
worker / MCP host 子进程、隧道、setup 脚本、内存探测、升级安装和 PTY 终止——只留下一套实现。
现在只要 CLI 源码在 `platform/process/node-process.ts` 之外导入 `child_process` 或 `cross-spawn`、
引用 `node-pty` 或调用 `process.kill`，`pnpm check:cli-process-boundary` 就会失败；它的白名单
只包含两类：在独立进程中运行的脚本源码文本，以及 node-pty 加载器。`apps/cli/AGENTS.md`
也写明新代码必须经过这一层。

新增能力：`runCommand` / `runCommandOk`（收集输出，每路输出有上限）、`runCommandSync`（供
按约定必须同步的调用方使用，必须带超时）、`isPidAlive`、`ManagedProcess.closed`（退出且 stdio
已读尽）、`SpawnSpec.windowsDetached`（daemon runner 需要比启动它的终端活得久），以及对应的
Promise 门面 `runCommandText`、`runCommandTextSync`、`startProcess`、`isPidAliveSync`，外加
PTY 用的 `terminatePtyProcessGroup`。

各项决定，均有测试覆盖：

- **命令正常结束后，保留它有意留下的进程。** 只有调用方不再等待时（超时、中断、输出超限），
  `runCommand` 才结束该命令的整棵树。另一种做法是每次命令成功后都清理整个进程组，但它会杀掉
  git 或 gh 有意留下运行的辅助进程，而 `execFile` 从不这样做，所以没有采用。输出超限时立即
  失败并结束整棵树，与 `execFile` 一致。
- **setup 脚本只在失败时整棵结束。** 成功脚本启动的后台服务会保留；失败或超时的脚本不再留下
  后代进程（例如装到一半的 `pnpm install`）。
- **PTY 先挂断再终止。** 交互式 shell 会把每个作业放进各自的进程组，只结束 shell 所在的组会
  漏掉它们。所以先向 PTY 发 SIGHUP，再对 shell 的进程组执行有上限的升级。
- **stdio MCP 服务器运行的 `lody` 子命令留在 agent 的进程组里**，这样会话拆除时仍能触及它。
- **Windows 通过 `rundll32 url.dll,FileProtocolHandler` 打开 URL**，URL 不再经过 cmd 的元字符解析。
- **补上原先缺失的超时。** 同步调用方（`diff-line-counts`、`git-identity`）现在有超时；worktree
  的 git 输出每路上限为 64 MiB，以前没有上限。

让命令自成进程组的代价：在 POSIX 上 `detached` 会新建会话，命令因此失去控制终端。前台运行
CLI 时按 Ctrl-C 不再能传到这些命令；打开 `/dev/tty` 的提示（例如 ssh 口令）会直接失败而不是
提示输入。daemon 本身没有终端，所以只影响前台 CLI 运行。SIGKILL 之后的等待现在处处都有上限，
因此像 `cloudflared stop()` 这样的调用可能会 reject，而不是一直挂起。

未覆盖：Electron main、`packages/cli-supervisor` 和 `packages/shared`（共 13 个文件）运行在 CLI
之外，仍然直接启动进程。要让它们也使用这一层，需要把它移到它们能导入的包里，这是另一项决定。

## 验证

- 新增 `@effect/vitest` 0.26。新测试 `tests/platform-process.test.ts` 用 `TestClock` 驱动时间，
  跑在内存进程表 `tests/fake-process-table.ts` 上（模拟进程组、被忽略的信号与 `taskkill`），覆盖：
  比 leader 活得久的后代、恰好在宽限期结束时升级、SIGKILL 被忽略时失败、强制终止、已空的树、
  温和终止进行中到来的强制终止立即升级、不等宽限期、作用域释放、温和 `taskkill` 被拒、`taskkill` 卡住、残留组先被跟踪后被
  移除，以及一棵真实的 POSIX 进程树。
- sandbox 与 `shutdownLocalAcpAgent` 的测试改为对假进程表的状态断言，不再统计 `kill` mock 的调用次数；
  `Session` 测试覆盖并发终止合并、`terminated` 中的 agent 退出码，以及进程树残留时的 reject。
- 消融：逐一关闭整棵树存活判断、残留组跟踪、合并、reject 与退出码来源，每一项都会让至少一个测试
  失败。早先有一个串行化终止的进程级锁，关闭后没有任何测试失败；它唯一的效果是让强制终止排在
  温和终止之后等待，因此已删除。现在有测试固定"立即升级"的行为，重新加上这个锁会让该测试失败。
- CLI 类型检查通过；CLI 全量测试通过（3199 个，4 个跳过）。
- 未验证：真实 Windows 主机上的行为；真实委派 cgroup 层级上的行为（测试用的是伪文件系统）；
  对 ACP `terminal/kill` 延迟的影响——忽略 SIGTERM 的命令现在会让 kill 请求最多挂起 5 秒再 SIGKILL，
  而以前它根本不会死。
