# 取消 Turn 收尾期间保留 session presence

Status: implemented
Translation: current
PR: [#1518](https://github.com/LodyAI/Lody/pull/1518)

[English](2026-10-12-session-presence-cancellation-release.md)

## 摘要

可见 Turn 取消时，旧代码会先清除 active presence，再完成取消收尾并等待原始 ACP
prompt 退出。因此，agent 仍忙且下一轮 Turn 正确被阻止时，用户却会看到没有活动工作。
现在由取消 Effect finalizer 依次完成原始工作清理、清除 presence 子 Scope、释放 Turn
执行位置。这修复了释放顺序，但不代表 P6 原生心跳与 session 租约迁移已经完成。

## 所有权与决定

触发条件是可见 Turn Scope 关闭，包括外部中断和初始化 watchdog。可见 Turn 同时拥有
取消收尾与 presence 子 Scope；取消 finalizer 显式依次完成「取消/ACP drain →
presence clear → Turn 位置释放」。presence 在 collaboration-stop 检查之后才取得，取消 finalizer 则在
检查前登记，以覆盖提前退出。不可中断的 acquireRelease 先创建子 Scope，再登记取消收尾，防止中断发生在登记之间。
收尾失败时父 Scope 仍尝试关闭子 Scope，但保留 Turn owner；只有收尾和 presence 释放
成功后才开放下一轮，遵循锁定的 Effect 4.0.2 Scope 语义。

Stop 只取消本地 prompt 等待，不证明原始 prompt 已完成。现有取消 finalizer 保留
所有权，直到原始 ACP 工作结束或终止成功；终止失败时仍等待原始工作最终结束。
没有新增超时、替换路径或错误投影。release waiter 开放下一轮之前，旧 presence 必须
已经清除。

本改动依据现有 [presence 契约](../../../docs/cli-lib-loro-presence.md) 修复消费者
顺序，并保留 [compaction 取消决定](2026-09-10-context-compaction-terminal-state.md)。
完整 P6 迁移还需要覆盖 controller 的计时器、监测，以及 MessageHandler 的真实阶段
更新和清理消费者；这些未完成依赖会显著扩大本修复，因此迁移单独推进，不把 Legacy
计时器称为原生能力。P5 owner 仍遵循其
[决定](../architecture/2026-10-12-effect-workspace-presence.md)。

## 验证

现有 raw ACP drain 套件接入真实 presence controller 与可观察的本地 presence map。
四个确定性分支覆盖成功结束、失败结束、drain 截止后成功终止、终止失败。各分支验证
保留原始工作时 presence 仍在、下一轮提交被阻止，以及 release waiter 允许交接时
presence 已清除。四个用例在未修改实现上均失败，因为 drain 期间 presence 已被清除。
会话执行/controller 的 258 项测试通过。根类型检查、格式、`check:quick` 和文档检查
通过。完整本地检查遇到继承的 production React 测试环境及既有 Git/进程 fixture
失败；提交版本仍须由 CI 在干净环境中验证。
