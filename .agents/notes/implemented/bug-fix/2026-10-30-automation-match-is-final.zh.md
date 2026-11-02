# Automation 匹配结果一经提交即确定

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-automation-match-is-final.md)

## 摘要

已匹配的 Automation 在重新求值时可能看不到产生结果的事件，导致续接永久阻塞。匹配结果与 continuation 一经提交即确定；恢复时使用原结果，并检查当前授权、Session 接纳及 Host 记录的来源证据。这不保证事件在首次检查之前仍然可见。

## 边界

Workspace owner 只在 Wait 检查期间执行程序。账本以事务提交结果、证据和 continuation 身份；重启后同一 receipt 负责交付，不再执行程序。取消仍撤销 Wait 和 receipt，Stop 仍阻塞接纳直到恢复；既有 PR 关联、HEAD 与 workflow 证据检查仍可取代或延迟交付。准备前后的接纳检查立即记录一致的终态或可重试结果。需要等待新条件时应创建新的 Wait；这里不引入隐式持续 JavaScript guard。

Session 和 Inbox owner 继续负责接纳、取消和不确定提交的核对。Effect runtime 继续负责求值与取消，Promise 桥负责持有并等待 Session 读取。旧的已匹配 Wait 已保存结果和 receipt 身份，因此不需要存储迁移。本决定修正 [Stop 决策](2026-10-30-automation-pending-observations-and-stop.zh.md)中之前的谓词复查行为。

Workspace 回归测试匹配合成事件，在 Stop 上阻塞，使事件移出 50 条读取窗口，重启磁盘 owner，并验证恢复后原结果恰好进入一次 Session 队列。现有测试覆盖取消和 CI 证据变化；真实 Provider 和跨设备交付尚未测试。
