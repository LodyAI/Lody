# 导入 ACP 对话的身份

Status: draft
Translation: current

[English](imported-acp-session-identity.md)

## 场景

用户配置了多个同类型 ACP Agent，导入对话后继续聊天，或在首次发送前 fork。
这些操作应保留所选 Provider 和原始对话身份，不能猜测默认账号。

## 职责

项目历史选择具体的机器本地 Provider。守护进程在列举或读取历史前验证机器、
配置 ID 和 Agent 类型。选择失效或不匹配时直接失败，不重试默认账号。目录按
Provider ID 隔离；不同已绑定 Provider 下相同的原生 ID 不代表同一导入对话。
已有历史条目 ID 和哈希保持稳定。旧的未绑定导入仅在所选 Provider 列出了其
来源后补齐绑定，已有绑定永不替换。

客户端仅在机器声明 `localProjectHistoryProvider` v1 后发送具体配置。
旧守护进程保留按 Agent 类型分组的界面；旧请求仍优先使用唯一的同类型
Provider，否则保留原有默认启动行为。不全量迁移工作区中的旧对话。

导入来源身份与 Lody 自有运行会话身份分开保存。续聊、普通 fork 和新 worktree
fork 使用同一解析器：优先自有运行会话，否则使用导入来源。历史冲突的来源
不能作为 fork 目标，除非已有较新的自有运行会话。仍要求 Provider 原生支持
fork 和所需的精确轮次边界，导入不能伪造能力。

导入模型、模式和选项保留来源报告的配置，不虚构 Role 来源，也不替换为当前
Provider 默认值。fork 仅复制属于最后一个已复制用户轮次、且原生身份匹配的
运行配置，并关联到目标原生会话。fork 较早轮次不能继承较晚轮次报告的设置。

## 证据

- [身份解析器](../packages/shared/src/session-acp-identity.ts)
- [导入服务](../apps/cli/src/lib/local-project-history-sync-service.ts)
- [Fork 服务](../apps/cli/src/session/session-fork-service.ts)
- [决策与验证](../.agents/notes/implemented/bug-fix/2026-09-28-imported-acp-session-identity.zh.md)
