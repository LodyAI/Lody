# 未释放的 Session 资源可重试

Status: implemented
Translation: current

[English](2026-10-15-unreleased-session-resources-retry.md)

## 摘要

升级到 0.105.0 后，大量 turn 在发送 prompt 前就以 `turn_pre_prompt_failed`
失败，错误为 "Session … resources were not released"。0.105.0 开始报告 SIGKILL
之后无法证明已经消失的进程树，这本身是正确的。但预备 Session 的回收一旦失败，就会永久保留
rejection，导致该 Session 之后每次创建都失败，直到 daemon 重启。现在回收失败仍然阻止
同一 Session 的替换，但下一个调用方会重试。另外两种情况其实没有真正存活的进程，现在判定为成功：
只剩僵尸进程的进程组，以及 `taskkill` 报告失败但根进程实际已经结束的 Windows 进程树。
真正存活的进程树仍然失败。

## 问题

当进程树在有界的 SIGKILL 等待后仍然存在时，`Session.terminate` 会抛出
`AggregateError`，并保留 sandbox、句柄和凭据以供恢复
（[释放失败决策](2026-10-10-effect-process-release-failure.zh.md)）。
在 0.104.0 中，同样的 sandbox 失败只记一条 debug 日志。

失败在预备池里被固化。一个 turn 的配置与预热好的预备 Session 不匹配时，
会等待 `claim.cleanup`；resume 会等待 `discard`。当预备 Session 的强制终止失败时，
`expire()` 把这个 rejected promise 存进 `retiring`，并且只在成功时才删除。之后每一次
claim 未命中、discard 或替换预备，拿到的都是同一个 rejection。即使进程树后来已经退出，
也没有任何代码重试释放。

两种常见的终止失败其实并没有存活的进程：

- **孤儿僵尸进程。** 孤儿进程被过继给一个从不调用 wait 的回收者，典型情况是 daemon
  在容器里作为 PID 1 运行。孤儿会让原进程组一直可以接收信号：Linux 上
  `kill(-pgid, 0)` 成功，macOS 上返回 `EPERM`。僵尸进程不持有任何资源，
  也没有任何信号能结束它。
- **Windows 部分失败。** `taskkill /T /F` 在已经结束根进程之后，只要有一个后代进程
  拒绝终止，就以状态码 1 退出。`terminateTree` 遇到这个投递错误就立即失败，
  没有检查根进程。

## 决策

- `SessionPreparationService` 为每个 Session 保留一个 `Retirement`。成功或进行中的
  尝试会被共享。失败的尝试仍然阻止该 Session 的替换；下一次 `claim`、`discard`、
  `start`、过期或关闭会发起新的尝试，覆盖前驱链和记录自身的资源。Session manager
  的预备 `cleanup` 可以重试（Session 或 sandbox 会重新发起终止；sandbox cleanup
  失败后改用 `recoverCleanup`）。创建阶段回滚失败时，`SessionPreparationCleanupError`
  会携带这个重试方法。第一次尝试仍然报告原始失败。
- `terminateTree` 把失败的 SIGKILL 投递视为“未经证明”而不是致命错误：它会等待有界的
  `killWaitMs`，只有进程树仍然存活时才失败，失败中保留原始的投递错误。
- `ProcessTree.hasRunningMembers` 是精确但较慢的成员扫描。只有发出信号
  `MEMBER_SCAN_DELAY`（250 ms）后进程树仍然存活时才运行，并在宽限期或 SIGKILL 等待
  超时时再运行一次；正常的进程树在这之前就已经消失。POSIX 进程组通过
  `NodeProcessApi.listProcessGroup` 实现：Linux 读取 `/proc/<pid>/stat`，其他平台
  执行一次有超时的 `ps -axo pid=,pgid=,stat=`。只有当进程组中可见的成员全部是僵尸
  进程时，才判定为已消失。扫描不可用、存在运行中的成员，或者扫描结果为空但内核仍然
  报告该进程组存在，都会保持失败。
- `Session.terminateOnce` 并行结束各进程树和 sandbox。sandbox 跟踪的是同样的进程组，
  依次结束会让每次对残留进程的有界等待翻倍：报告的日志里每次失败前都等了十秒。

## 备选方案

- **恢复 0.104.0 的“记日志然后继续”。** 不采用。后继者可能与仍在运行的 agent、
  端口或锁发生争用，释放失败决策明确禁止这种情况。
- **失败一次后就解除阻止。** 不采用。旧进程树可能仍在运行时就会复用工作区，违反
  [预热交接](../../implemented/simplification/2026-10-16-remove-draft-session-preparation.zh.md)。
- **由我们自己回收孤儿。** 不采用。成为 subreaper 或调用 `waitpid(-1)` 会抢走
  Node 自己句柄所拥有的子进程。

## 权衡与限制

如果某个 Session 的进程树真的无法杀死，每个 turn 会在一次有界重试后失败。每个 turn
因此多花大约五秒，而不是立即返回过期的 rejection；好处是进程树一旦消失就能恢复。
判定只剩僵尸的进程组大约只需 `MEMBER_SCAN_DELAY` 加一次扫描，之后注册表就会遗忘
这棵树。在 macOS 上这次扫描是一次最长两秒的同步 `ps`，只有存活超过该延迟的进程树才会
付出这个代价。在启用
`hidepid` 时，其他用户的进程不可见。因此，如果一个进程组中可见的成员只有僵尸进程，
即使还剩下外部用户的进程，也会被判定为已消失；不过这样的进程我们本来也无法发送信号。
常驻 Session 表的行为不变：非预备 Session 的终止失败仍然走原有的恢复路径。

## 验证

- `packages/shared/tests/process.test.ts` 使用 fake process table 和 TestClock，
  覆盖以下场景：只剩僵尸的进程组在 SIGKILL 后 `MEMBER_SCAN_DELAY` 时判定成功，在
  宽限期内也无需 SIGKILL 即判定成功；无法枚举成员的进程组仍然失败；Windows 根进程在
  `taskkill` 部分失败后实际已结束；Windows 根进程仍然存活。
- `session-terminate-cleanup.test.ts` 证明等待 agent 进程树时 sandbox 已经在终止；
  该测试在原来的串行顺序下会失败。
- `session-preparation-service.test.ts` 覆盖回滚失败和释放失败的重试，以及失败期间
  持续阻止替换、直到重试成功。
- `session-manager.test.ts` 先触发一次预备释放失败，再验证之后的冷启动创建成功；
  该测试在旧 service 上会失败。
- 一次性的本地探测确认 Linux `/proc` 扫描能识别真实的僵尸进程和存活成员。
  这个探测依赖真实计时，因此没有提交。
- macOS 的 `ps` 解析和真实 Windows `taskkill` 的退出码没有在对应平台上实际运行。
