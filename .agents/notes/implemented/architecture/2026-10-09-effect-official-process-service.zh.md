# 官方 Effect 进程服务与 Lody 的有界资源所有权

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1065

[English](2026-10-09-effect-official-process-service.md)

## 摘要

第一轮迁移统一了 OS 调用，但仍暴露无作用域的 spawn 接口，container 所有权也依赖手动清理。
本次采用 Effect 4.0.2 官方 ChildProcessSpawner 接口、派生命令执行方法及 Node Stream/Sink
适配器，通过作用域管理获取，并在初始化被中断时回收资源。官方默认 Node 实现尚不能满足
Lody 的有界关停与原始 ACP/IPC 句柄要求，因此保留 Lody 的进程树后端。CLI 的日志组合模块
不再提供 Promise 包装；尚未迁移的入口直接使用 shared 兼容函数，并可传入明确的取消信号。
命令的 Scope 在整组退出和 stdio 关闭后释放，避免复用 Session 时累积进程对象和输出缓冲。

## 官方能力与后端边界

ChildProcess.make 描述命令，ChildProcessSpawner 是注入的能力。ProcessSpawnerLive 使用官方
ChildProcessSpawner.make 实现服务，派生 string、lines、streamString、streamLines、exitCode。
官方 NodeStream、NodeSink 管理读写及背压。runCommand 的依赖改为这个服务，并发收集其输出
Stream，同时执行 Lody 原有的单路输出上限。

采用的是官方接口和流适配器，不是直接使用默认 NodeChildProcessSpawner.layer。阅读发布的
@effect/platform-node-shared@4.0.2 源码确认：

- terminateProcessGroup 虽有原生时间的有界轮询，最后仍无条件 Deferred.await(exitSignal)。
  根进程在 SIGKILL 后仍存活时，Scope 释放可能一直等待。
- Windows taskkill 用没有截止时间的 execFile，并在 finalizer 中等待。Lody 保留独立有界等待。
- 它不交出 ACP stdio 回调、IPC、立即获取 pid、同步启动与退出钩子所需的原始 ChildProcess。
- 默认 Scope 释放可能结束正常退出命令的后代。runCommand 必须保留命令主动留下的后台助手。

v3 的“不升级到强杀、强制合并环境变量”不再是理由：v4 已有 forceKillAfter 和 extendEnv。
上述实际约束才是保留自定义后端的理由。不复制或修改上游实现。NodeProcess 仍是唯一可注入
的 OS 边界，公开 Effect 程序使用官方服务。支持普通 stdout/stderr 管道；额外 fd 和右结合
管道返回有类型的 BadArgument，不静默执行另一种行为。既有原始 IPC 调用保留明确的兼容入口。

## 所有权与中断

spawnProcess 要求 Scope。后端在等待启动或可中断的后续初始化之前登记释放。
OS spawn 后的 owner hook 失败也会在释放已登记后上报。命令在收集输出时被中断，会释放整棵
进程树；container 初始化失败或被取消，会关闭刚创建的子 Scope。初始化成功后，只有仍在运行
或尚未确认结束的进程继续挂在 Session 的父 Scope 下。配置完成后，登记表等待整组进程退出
和 stdio 关闭（close），再关闭命令的子 Scope；Effect 会将它从父 Scope 脱离，释放进程对象
和输出回调。此前仅移除空进程组，Scope 的 finalizer 仍持有这些对象，直到 Session 清理。
自动释放在配置成功后才启动，避免快速退出的命令在配置或加入 cgroup 期间被提前关闭。
container 释放会结束已跟踪的进程组，包括根进程先退出的后代，
然后释放宿主资源并停止监控 fiber。

两个 container 共用进程组登记表，在配置或加入 cgroup 之前登记。加入失败（包括首进程已退出的
ESRCH）会使 spawn 失败并回滚子 Scope；回滚后仍存活的组保留追踪。cgroup 终止同时处理内核
子树和这些进程组。只有确认消失的组才能移除；存活探测失败保留所有权。旧 noop 适配器也必须
确认上一代的组已结束才能替换容器，即使其 Scope 已经关闭。并发启动共用同一个新容器，
不会各自建立新一代并丢掉其它调用方的资源。

cgroup 成员状态读取严格处理：权限或 I/O 错误、目录仍在时缺少控制文件，以及非法 populated
状态都会产生 TerminationFailed。只有确认目录不存在或成功读到空成员状态，才能证明资源已结束。
cgroup.events 成为初始化必需能力。best-effort cleanup 记录失败，并保留目录和进程组供重试；
可选统计计数仍维持原有的 best-effort 策略。

shared Promise runner 把明确的 AbortSignal 交给 runPromiseExit，但仍启动独立根 fiber。
用 tryPromise 包装且不传递信号，无法传播取消；即使传递信号，也不会自动让外层 Promise
包装等待内层 finalizer 完成。Effect 调用方应直接 yield 服务。同步兼容 startProcessLegacy 仍由
旧调用方手动持有，支持明确的取消信号；需要证明终止的调用方等待 terminate。它不被描述为
具有 Scope 所有权的 Effect 获取。

已关闭的 Effect container 拒绝新 spawn。只有旧的可复用 noop sandbox 会为后续一代进程创建新的
container 和 Scope；已删除的 cgroup 不会自动重建。

## CLI 组合与 PR 范围

删除重复的 CLI promise-facade.ts。process-options.ts 只组合日志与依赖，不执行程序。
现有 Promise 调用方直接导入 shared 兼容 API，并传入这些选项。进程核心、ACP 调用方、
container 和这份决定属于 #1065；其它 CLI 调用方的导入调整及守卫指引属于 #1069；
跨运行时调用方通过 #1348 继承服务，不增加另一份实现。

#1065 合入后，[#1069](https://github.com/LodyAI/Lody/pull/1069) 为九个 shared 执行兼容入口
统一加上 Legacy 后缀和 deprecated 标记，runner 与手动持有的 handle 类型也带此后缀。
Text/Sync 仍表达输出和阻塞方式，Legacy 表明临时兼容用途，不代表另一套进程实现。
删除旧导出，调用方使用完整名称，不通过别名隐藏后缀。新 Effect 工作流组合核心 API，
由所属入口统一执行；Layer 构造器、纯转换函数和返回 Effect 的核心 API 保持原名。
进程守卫拒绝旧入口名称及隐藏 Legacy 的别名，跨运行时调用方在 #1348 同步。
此次只改命名和说明：显式取消、有类型的错误、有界进程树终止和 Scope 释放保持原实现，
继续使用已有行为测试验证。

## 验证与限制

行为测试覆盖官方输出方法及管道、替换环境变量、Scope 中断、孤儿后代、owner hook 失败、
container 初始化取消、明确的 Promise 入口取消。保留已有的终止、输出、超时、失败 spawn
及真实隔离进程测试。测试使用就绪信号和 TestClock，没有新增真实 sleep。假进程表改用
Node Stream，实际执行官方适配器。回归案例覆盖带存活后代的 ESRCH、回滚失败后的重试、
noop 清理失败与复用，以及 EACCES/EIO/ENOENT 成员状态读取错误。恢复原 container 实现时，
对应回归测试都会失败。新增确定性测试在 Session 清理之前观察实际命令 Scope 的 finalizer：
两个 container 连续执行命令后均释放；延迟 stdio、残留后代和未完成配置均保留所有权。
禁用自动释放会使保留的 Scope 释放案例失败。真实 noop 进程探针在未关闭的 Session Scope 下执行
20 个各输出 8 MiB 的命令：禁用自动释放时，GC 后仍保留约 160 MiB 的数组缓冲；启用后，
container 清理前已回到基线附近。这是本机进程实验，不代表生产环境内存测量。

分别禁用自动释放、stdio/进程组等待、失败组保留、严格 cgroup 读取、owner hook 和 Git
退出宽限期，七项消融都会使保留的行为测试失败。复用测试运行两个命令，足以区分逐命令
释放和等到 Session 清理才释放。重复释放案例和只检查 mock 调用的终止测试，合并为实际
资源状态断言。删除仅供测试的 spawnScoped 别名，以及 terminateAll 已证明退出后重复的
cgroup 等待。临时探针和消融脚本不进入产品代码。

未验证真实 Windows、Linux 委派 cgroup 和签名桌面安装包。Windows 根进程先退出后仍需
Job Object 才能保留后代归属。Session、ACP、Turn 层仍待迁移，本次不声称已通过其 Promise
接口实现端到端结构化取消。
