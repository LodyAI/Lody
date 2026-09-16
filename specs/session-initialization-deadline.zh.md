# Session 初始化期限

Status: draft
Translation: current

[English](session-initialization-deadline.md)

Session 回合从 `initializing` 开始，并在此状态停留，直到 Lody 完成提示 Agent 之前必须做完的
工作：解析请求者身份、验证机器访问权限、准备 worktree、下载托管运行时，以及启动或恢复 ACP
Agent。只有这些工作完成后，回合才会进入 `running`。

上述每一步都依赖 Lody 无法控制的东西——一次云查询、一个远端仓库、一次下载、一个子进程。
因此 Lody 保证：**初始化总会到达终态**。初始化停止推进的回合会以可见错误失败，绝不无限等待。

## 什么算作进度

该期限衡量的是静默，而非时长。计时从会话已发布状态的最近一次变化开始，因此会上报进度的步骤
会不断重置它。发布递增百分比的托管运行时下载，可以合法地耗费传输所需的任意时间；而卡在同一
百分比上的同一次下载，则是停滞。

不发布任何中间进度的步骤——准备克隆、启动 Agent 进程——从开始时刻计量，因为对它们而言，
「没有任何已发布的变化」是唯一可用的信号。

每个初始化步骤都有自己的预算，因为它们诚实的最坏情况相差数量级。Agent 启动前的簿记工作最紧：
其唯一有意为之的慢依赖——请求者档案查询——本身已带 60 秒期限，因此明显更长的等待是卡死而非
慢响应。克隆仓库最宽松，因为它的输入规模与用户链路速度都没有上界，而这两者都不该由 Lody 臆断。

## 用户看到什么

停滞的回合会像其他已知的 pre-prompt 失败一样失败：会话记录 `session_init_failed`，消息中
指明是哪一步陷入静默、给了它多长时间，随后 Session 回到 `idle`。它不会被悄无声息地置回
`idle`，也不会被报告为已取消——用户并没有取消它。重试的方式就是再发一次消息。

让回合失败同时会释放初始化所占用的资源：会话的 active presence、回合注册，以及待处理的
Agent 进程。在释放之前，active presence 会让该会话一直被计为繁忙，这既抑制了空闲回收，
也让机器对外发布一个看似在工作、实则什么也没做的 Session。

该期限是对「永不应答的依赖」的兜底，不是性能预算；触发它的步骤说明别处存在缺陷。

## 证据

看门狗及其按阶段的预算位于 `apps/cli/src/lib/loro/session-active-presence.ts`；
回合侧的执行是 `apps/cli/src/session/session-execution-service.ts` 中的
`awaitInitializationStall`。作为校准基准的请求者档案期限是
`apps/cli/src/session/session-user-resolver.ts` 中的 `USER_PROFILE_TIMEOUT_MS`。

本草案记录所请求的保证。预算是依据单台机器的守护进程日志（一周内 923 次初始化）以及促成此项
工作的那一次线上卡死校准的，尚未在慢速链路上的托管运行时下载或大仓库克隆场景中验证。
覆盖测试位于 `apps/cli/tests/session-execution-service.test.ts`。
