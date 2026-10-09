# Lody 统一的 Effect v4 进程基础

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1065

[English](2026-09-27-effect-process-tree-layer.md)

## 摘要

各处独立的进程关停循环可能卡住、留下后代进程，或者把失败当成成功。现在进程核心直接建在 shared，
用 Effect v4 的服务、作用域和有上限的终止过程管理生命周期。ACP agent 与会话容器使用同一实现，
其余调用方在后续层迁移。Windows 的孤儿后代仍需要 Job Object；真实 Windows 与 cgroup 主机尚未验证。

## 范围与 PR 归属

这份记录随尚未合并的 stack 重排，反映 v4 优先的交付顺序。
[v4 基线](2026-10-09-effect-v4-migration.zh.md) 属于 #1070；
[计划](../../proposed/architecture/2026-09-27-effect-turn-execution-and-acp-process-ownership.zh.md)
源自 #1057，由 #1355 恢复到 main，因为 #1057 合入了原基础分支。
#1065 负责进程核心、CLI 日志与容器、Session 关停、辅助 ACP agent、认证与历史探测
以及测试。核心直接位于 @lody/shared/node/process，后续 PR 只增加调用方，不再搬迁或复制实现。

## 所有权与终止

NodeProcess 是同步 OS 边界，通过 Context.Service 和 Layer.effect 提供。spawn 同一步挂好监听器，
Deferred 分别记录启动、退出、stdio 关闭与输出溢出。spawnScoped 通过 acquireRelease 管理资源，
门面给尚未迁移的 Promise 调用方使用；CLI 适配器只接入日志。

ProcessTree 区分发信号与整棵树是否存活。POSIX 进程组在首进程退出后继续跟踪，cgroup 容器保留
限制与统计。terminateTree 依次 SIGTERM、有上限的宽限、SIGKILL、有上限的退出确认；仍存活就返回
TerminationFailed。finalizer 中用 Clock 控制轮询上限，因为不可中断清理不能靠中断型 timeout 限时。
Windows taskkill 单独限时、检查退出码，根进程已退出时不再发信号。

spawn 失败没有可用 pid，绝不能向 pid 0 发信号。Windows 裸命令只从绝对 PATH 条目解析，不从仓库
cwd 查找。正常退出保留命令故意留下的后台进程；超时、中断或输出溢出则终止其进程树。
持锁命令保留 SIGTERM 宽限，让 git 清掉 index.lock；只读探测可以选强制策略。终止告警进入真实日志。

## Session 与失败处理

只有并发的终止调用共享结果；完成后再调用会重新清理。强制调用立即升级，即使温和关停尚未结束，
也不等待终端的温和清理。事件携带 agent 的退出信息；晚创建的 agent 仍会被清理。

需要证明进程已结束的调用方收到类型化错误。丢弃与归档路径捕获并告警，避免终止失败覆盖有效结果，
或跳过冷启动回退。已关闭的 cgroup 容器拒绝启动，强制终止通过 cgroup.kill 覆盖嵌套子组。

## 运行时边界

这里完成的是 OS 进程基础，不是整个 Session/Turn 重写。Session 与 ACP 类仍使用临时 Promise 门面，
daemon 级运行时留给后续会话资源阶段。此 stack 不引入 v3 进程实现，也不先在 CLI 建一份临时副本。

## 验证

重排后的每层分别执行 pnpm check、格式与文档检查。TestClock 与注入的进程表覆盖升级、强制取消、
仍存活的进程树和 finalizer 上限。真实隔离子进程测试通过明确的 readiness 信号等待，并清理整组，
包括 spawn 失败安全性与 unref 子进程不阻止父进程退出。

这些是本地证据；未验证真实 Windows、Linux cgroup 或签名安装包。taskkill 无法保留 Windows
父进程已退出后的后代身份，因此 [#429](https://github.com/LodyAI/Lody/issues/429) 仍待单独的
Job Object 工作补齐。
