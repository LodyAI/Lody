# Windows Inbox 资源隔离：推迟的第二阶段

Date: 2026-10-21
Status: proposed
Translation: current
PR: [#1778](https://github.com/LodyAI/Lody/pull/1778)

[English](2026-10-21-windows-inbox-containment.md)

## 摘要

Windows 启动恢复不能仅凭已记录的根 PID 推断整棵进程树已经释放：父进程退出后后代仍可能存活，PID 复用也会改变身份。第二阶段拟在资源 acquisition 时使用 Windows Job Object 或等价受控容器，持久化代际身份并验证整个容器实际退出。[本次人工恢复](../../implemented/bug-fix/2026-10-21-manual-inbox-recovery.zh.md) 不实现该方案。旧记录或证据不确定时继续走明确的离线人工流程。

## 重新评估的触发条件与拟议边界

如果 Windows stale ownership 反复发生，或人工恢复持续造成明显摩擦，再启动原生隔离工作。不得以删除 Windows fail-closed 判断作为捷径。[Windows Job Object 官方契约](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 描述进程关联、子进程继承、breakaway 和终止语义；Job 名称或父进程退出本身都不是安全恢复的证明。

- 在任意进程代码开始执行前建立容器归属，包含部分 acquisition 的回滚。不得默许未纳管启动或 breakaway 逃出证明范围；必须拒绝或明确保留不确定状态。
- 归属必须覆盖实际 Session sandbox 生命周期。ACP 进程可能跨多个回合复用，不能用每个 prompt 一个 Job 并杀死可复用 ACP 来冒充等价方案。execution 日志需关联正确 sandbox 代际和全部 acquisition。
- 持久化可在重启后验证的代际/资源身份、acquisition-complete 证据和未解决的终止失败。只有 PID 或缓存的 complete 标记不够。
- 证明整个容器/进程树实际退出，包括根进程已经退出但后代存活的情况。权限错误、探测不可用或日志写入中断均保持 unknown；清除 ownership 前通过 SQLite CAS 重查准确归属和快照。
- 旧记录继续人工恢复。永不重放 unknown 请求，也不把资源释放回执解释为 provider 成功。

## 上线前验收

必须有原生 Windows 测试，覆盖根退出而后代存活、嵌套子进程、breakaway 尝试、挂起/启动 acquisition 竞态、PID 复用、跨回合 ACP 复用、日志中断、权限错误、清理失败、重启及恢复期间归属变化。同时验证安全与可用性：释放得到证明后允许后继执行，不确定时保留 ownership，独立资源清理仍能完成，submitted/unknown 输入永不重放。设计评审还需明确支持的 Windows 版本，以及容器外部请求如何保有独立释放证据。
