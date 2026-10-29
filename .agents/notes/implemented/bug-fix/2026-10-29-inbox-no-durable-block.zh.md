# Inbox 可用性优先于释放证明

Status: implemented
Translation: current
Supersedes: [Manual Inbox recovery](../../archived/bug-fix/2026-10-21-manual-inbox-recovery.zh.md)

[English](2026-10-29-inbox-no-durable-block.md)

## 摘要

owner 提供的 0.107.2 事故中，桌面退出时三秒后强杀 CLI，没有留下 release receipt。 一个对话累计了 153 个历史 PID；重启的一次性探测无法证明释放，后续输入永久被拒。 Inbox 现在直接退役不确定执行且不重放，保持后续输入可用。 孤儿进程可能继续运行；重启后的孤儿清理由下一个 PR 处理。

## 决定与替代方案

整体可用性优先于局部释放证明。启动清除历史阻塞、结束中断输入、保留未知批次。 释放不确定和回执冲突不能锁住对话，以首份回执为准。SQLite activate 没有历史写入路径，启动退役只记 warn。 运行时失败先按对象移除旧 Session，再交还槽位。一次后台清理仅使用该执行旧句柄，预算五秒，不能释放或终止后继。 失败通过现有 Stop 提示和日志报告；drain 仍允许关闭 Inbox、runtime 和数据库。资源登记和现有 schema 不变，未知提交永不重放。

只增加退出时间只能减少一个触发源；改进 PID 探测仍无法证明缺失身份、PID 复用和 Windows 后代；保留持久阻塞再加 UI 手工确认仍使可用性依赖人工修复。这些方案被否决，改为退役输入、隔离失败 Agent。 [Operation Inbox 决定](../architecture/2026-10-12-operation-inbox.zh.md) 仅释放证明准入部分被取代。 [进程树决定](2026-10-15-unreleased-session-resources-retry.zh.md) 保留僵尸／Windows 终止规则，其旧后继阻塞被取代。 Session／ACP 依赖链尚未原生迁移，本次不扩展；使用已有原生 execution owner 与桥接层限制清理。

## 证据与限制

`apps/cli/src/orchestration/inbox/inbox.test.ts` 用真实 SQLite 覆盖退役、历史阻塞、未知不重放、首份回执与资源身份保留。 `apps/cli/tests/session-execution-service.test.ts` 覆盖终止失败、新 ACP 执行与可见提示，Coordinator 测试覆盖终止关闭。 上述事故数字由 owner 提供，未访问私有数据复现。不声称真实孤儿清理、Windows 主机或桌面安装包验收。
