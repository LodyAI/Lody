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

## 后续：整个仓库只用一层

又一个叠加 PR 把这一层移到 `packages/shared/src/node/process.ts`（`@lody/shared/node/process`），
连同门面和假进程表（`process-testing.ts`）一起。Electron main、CLI supervisor 与 shared 的 Node
辅助模块现在也都经由它。CLI 只保留自己的会话容器，以及一个只负责加上 CLI 日志器的薄门面。
边界守卫现在覆盖 `apps/cli/src`、`apps/electron/src/main`、`packages/cli-supervisor/src` 和
`packages/shared/src/node`（包括 `.cjs` 文件），并且也会标记 `<child>.kill(` 调用，确保所有终止
路径都走这一层。规则随代码一起移到 `packages/shared/src/node/AGENTS.md`。

决定：

- **单个模块，不用相对导入。** Electron 用原生的 `node --test --experimental-strip-types` 跑测试，
  无法解析省略扩展名的相对导入。因此 `process.ts` 保持为单个模块，`process-testing.ts` 也不用
  TypeScript 参数属性。
- **删除三份 `.cjs` 双胞胎文件。** `cli-detection`、`local-project`、`file-lock` 的手写 CommonJS
  副本重复实现了各自的进程逻辑。在仓库里搜索后，只找到它们自己的对照测试在加载它们。那些测试中
  独有的用例已改到 TypeScript 模块上。
- **锁的存活判断分三态。** `file-lock` 调用 `probePid`，结果为 `ours`、`foreign` 或 `missing`。
  只有 pid 仍属于本用户的存活进程时，锁才有效：EPERM 说明这个 pid 已经属于另一个用户，原持有者
  已不在。原来的 `kill(pid, 0)` 实现也是这个结果。首次迁移时曾短暂把 EPERM 视为存活，现在有测试
  排除这种情况。
- **`signalChildTreeNow` 同步执行。** 退出处理器无法 await，所以它只发信号，不等整棵树消失。
  如果用 fork 出去的 fiber，进程退出前一个信号都发不出去；在 Windows 上，`taskkill` 在同步步骤
  内就已启动。
- **supervisor 终止启动方描述的那棵树。** `LaunchHandle` 会说明它的子进程是否自成进程组；CLI 和
  Electron 都不以 detached 方式启动被监管的 CLI。如果没有关停通道或关停通道失败，supervisor 会
  通过进程树发送 SIGTERM；若这个 SIGTERM 无法送达，就提前结束宽限期。子进程树在 SIGKILL 后仍然
  存活，会让 supervisor 进入 fatal 状态。
- **Electron 退出使用有上限的进程树终止。** 退出时的所有权保持不变：仍有进程残留时，退出会失败。
  在 Windows 上现在会结束整棵树，而不只是根进程。

## 后续：正确性审查

对这组叠加 PR 与其所替换代码的审查发现了若干回归，均已在最上层 PR 中修复；除特别说明外，每项都先写了会失败的测试：

- **失败的 spawn 绝不会波及调用方自己的进程组。** 在 Node 报告 spawn 失败之前，`child.kill()` 会向
  pid 0 发信号，也就是 daemon（或 Electron main）所在的整个进程组。现在 `childTree` 把没有 pid 的子进程视为已结束。
  测试在一个真实且隔离的进程组中复现这个竞态。
- **被放弃的命令先有 SIGTERM 宽限。** 超时的命令过去会被立即 SIGKILL，git 因而留下 `index.lock`，
  阻塞之后所有写 index 的操作。`ABANDONED_COMMAND_POLICY` 现在先给 2 秒 SIGTERM。
- **finalizer 内的等待靠时钟限时，而不是靠中断。** 被放弃命令的终止在作用域 finalizer 中运行，那里什么都
  不可中断，所以一旦进程树挺过 SIGKILL（PID 1 daemon 下的僵尸进程、D 状态进程），`timeoutTo` 就会永远
  等下去。`waitUntilGone` 现在对照时钟截止时间轮询；`taskkill` 的截止时间由一个独立的可中断计时 fiber
  完成被等待的 Deferred。
- **进程组信号返回 EPERM 时改为等待，而不是失败。** 在 macOS 上，唯一成员是已退出但尚未被回收的 leader
  的进程组会返回 EPERM；现在交给有上限的等待来判定。真正属于其他用户的进程组在等待结束后仍以
  `TerminationFailed` 结束。
- **Windows 命令绝不从工作目录解析。** `cross-spawn` 会先在 cwd 中按所有 PATHEXT 扩展名查找，于是仓库里的
  `git.cmd` 会在自动 git 刷新时被执行。现在 `nodeProcessLive` 只通过 PATH 中的绝对路径条目解析裸命令名。
  找不到时，由 Node 自己的 spawn 报告 ENOENT。此前 cross-spawn 会用 cmd.exe 包装缺失的命令，导致
  `git_executable_not_found` 丢失，缺失的启动器 `.exe` 也被当成已启动。仅有单元测试：未在 Windows 上实际运行。
- **强制调用时 `Session.terminate` 会立即升级，也不等待终端。** 在温和终止进行中到来的强制调用现在立即
  SIGKILL，并结束温和流程中的等待（终端、`session/close`）。强制拆除不再等待终端命令的温和停止，因为
  sandbox 会直接杀掉它们。已完成的终止只有在此后没有启动新进程时才会被复用。
- **即使有进程树残留，归档也会释放 Session。** 这个失败以 warn 级别记录；归档、空闲状态写入与本地项目移除都会继续。
- **较小的修复。** PTY 的挂断信号就是温和信号：等待 2 秒，然后 SIGKILL。在 SIGHUP 之后立即发送 SIGTERM
  会让 fish 来不及把挂断转发给它的作业；这一项没有测试，因为竞态依赖时序。其他修复：
  - shell 环境探测允许 15 秒，且不缓存失败结果；
  - `rundll32` 使用可见的显示状态；
  - cgroup 容器在清理后拒绝 spawn，并把有成员的嵌套 cgroup 视为存活；
  - supervisor 不再通过一个共享的永不 settle 的 promise 保留每一次运行；
  - 调用方未传入 logger 时，进程层的警告会进入 daemon 的根 logger（或控制台）。

## 后续：最后几处进程调用

审查之后的全仓库排查发现还有三处进程不经过这一层，都在同一个 PR 中迁移：

- **CLI 的登录 shell 探测用的是 `shell-env` 库。** 它通过 execa 启动 shell，3 秒超时只能停止等待，不能结束
  shell：rc 文件卡住时，这个 shell 会一直存活到 daemon 退出。桌面端另有一套不同的探测。两者现在调用同一个探测
  `@lody/shared/node/login-shell-env`，它经由 `runCommandText` 运行，上限 15 秒。它保留了 `shell-env` 的分隔符、
  oh-my-zsh 与 tmux 防护，以及非 POSIX shell 的 zsh/bash 回退；也保留了桌面端的 `env -0` 与 `~/.bashrc` 加载，
  在不支持 `-0` 的环境（BusyBox）回退到普通 `env`。CLI 仍在 3 秒后放行 ACP 启动，探测结束后替换缓存值。
  该依赖已删除。
- **`@lody/code-review-helper` 用 `execFile` 跑 git**（供 `lody review` 使用），没有超时。现在改用
  `runCommandText`，上限 60 秒，同时适用 Windows 上命令绝不从仓库目录解析的规则。
- **守卫漏掉了几种写法：** 可选链与带括号的 `.kill(` 调用、`child_process` 的动态 import 与 `createRequire`
  导入、re-export，以及 cross-spawn 以外的进程库。现在它匹配任意导入位置上的模块名、一组进程库，以及任意接收者的
  `.kill(`，并且也扫描 `packages/code-review-helper/src`。用一个包含每种写法的探针文件验证过：每种都会被报告，
  而类型导入、`np.kill` 和非导入位置的字符串不会。

对这部分工作的二次审查又发现以下问题，均在同一个 PR 中修复：
- **探测输出丢失。** macOS 的 `/bin/sh` 会把 `echo -n` 原样打印，分隔符后的第一个变量因此损坏，所以分隔符改用 `printf` 输出。
  探测为自身设置的 oh-my-zsh 与 tmux 防护变量不再泄漏到返回的环境中。
- **桌面端探测失败的结果重新缓存。** 15 秒已足以覆盖冷登录较慢的情况，重试反而会拖慢每一次 CLI 启动。
- **预备阶段的清理在进程树残留时不再 reject**，冷启动回退仍会执行。这一项没有测试：真实的预备运行时没有测试入口。
- **已完成的 `Session.terminate` 不再复用。** 后来的 agent 留在 sandbox 里的进程也会被结束，失败的尝试会重试。
- **`windowsTree.signal` 对已退出的根进程不做任何操作。** 它的 pid 可能已经属于别的进程。
- **只读探测**（内存压力、进程表、登录 shell）使用 `READ_ONLY_ABANDON_POLICY`：到期直接 SIGKILL，不加 SIGTERM 宽限，
  免得撑长它们本就很紧的时间预算。可能持有锁的命令保留默认宽限。这是有意的取舍：调用方收到超时时，进程树已确认结束，
  立即重试不会与尚未退出的 git 竞争。
- **去除重复。** ACP 与 supervisor 的强制结束改用 `terminateChildTree`；CLI 门面新增 `logPrefix` 以保留 ACP 标签。
  会话 sandbox 复用 `unwrapSpawnFailure`，删除未被使用的共享版 `withSpawn`。

有意不迁的：
- 为独立进程生成的脚本（已在白名单中）；
- node-pty：唯一的 PTY 启动方式，它的进程组经由这一层结束；
- 构建脚本与 ACP 扩展子模块；
- Electron 的 `shell.openExternal`/`openPath`；
- worker 线程。

## 验证

- 新增 `@effect/vitest` 0.26。新测试（现为 `packages/shared/tests/process.test.ts`） 用 `TestClock` 驱动时间，
  跑在内存进程表 `packages/shared/src/node/process-testing.ts` 上（模拟进程组、被忽略的信号与 `taskkill`），覆盖：
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
