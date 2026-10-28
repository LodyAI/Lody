# 回收归档和删除会话的聊天工作目录

Status: implemented
Translation: current

[English](2026-10-28-chat-workdir-gc.md)

## 摘要

无项目会话创建的工作目录在归档、删除后仍永久留在磁盘上。现有工作树清理器现在也根据根会话状态协调聊天工作目录。删除会话时递归移除目录；归档时仅移除空目录，因为这些目录没有 Git 备份。非空归档目录保留至会话删除。

## 决策与证据

- [Session](../../../../apps/cli/src/session/session.ts) 的默认工作目录为 `<getLodyDataDir()>/chats/<sessionId>`；子标签页通过 [SessionManager](../../../../apps/cli/src/session/session-manager.ts) 复用根会话目录。[现有协调决策](../architecture/2026-09-11-session-worktree-reconciliation.zh.md)仅覆盖仓库工作树。本次扩展清理范围，不改变 Git 清理。
- [GC](../../../../apps/cli/src/session/worktree/worktree-gc.ts) 共用元数据完整性闸门、owner 查询、运行时延后、in-flight 排他和重试退避。仅接受名称安全的真实目录条目，跳过符号链接。active 和 unknown owner 保持不动，包括其他工作区的目录。
- 归档目录使用 `rmdir`：`ENOTEMPTY` 保留文件，不警告、不计失败、不设置重试。删除目录使用递归 `rm`。两条路径都不执行脚本、不记录分支、不调用 Git。清理失败仅影响该目录，之后重试；chats 根目录不可读也退避，根目录不存在则静默返回。工作树清理先于 chats 文件系统操作执行；聊天目录使用路径作为重试/in-flight key，因此同一 owner 遗留的工作树也保持独立。
- [MessageHandler](../../../../apps/cli/src/lib/message-handler.ts) 从 `getLodyDataDir()` 提供 chats 根目录。现有 Session 和终端解析器会在需要时重建缺失目录。合同：[生命周期 Spec](../../../../specs/session-worktree-lifecycle.zh.md)。

公开会话文档现已用中英文说明聊天工作目录删除后无法恢复、归档仅回收空目录。`rmdir` 返回 POSIX `EEXIST` 时与 `ENOTEMPTY` 一样保留非空目录，不警告、不计失败、不设置重试退避；所属测试验证了两种错误码。

## 验证与限制

[所属测试套件](../../../../apps/cli/tests/worktree-gc.test.ts) 使用真实临时目录与注入时钟，覆盖保留/移除、元数据/运行时闸门、缺失/不可读根目录、符号链接/名称过滤，以及注入目录忙或 owner 读取失败后的恢复，并验证独立真实工作树仍被移除。22 项 GC 测试和 24 项终端清理测试全部通过，CLI 类型检查、改动文件 lint、格式和文档检查也通过。完整 `pnpm check` 在使用系统 Git、移除继承的 `GIT_*`/`LODY_GIT_*` 变量的子进程中通过。非空归档聊天目录有意保留至会话删除；永久删除移除的文件没有备份或恢复保证。这些测试不代表已完成真实 daemon 或跨设备验收。
