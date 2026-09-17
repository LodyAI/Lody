# Devin subagent 生命周期条目

Status: implemented
Translation: current

[English](2026-09-17-devin-subagent-lifecycle.md)

## 摘要

Devin CLI（`devin acp`）把 subagent 渲染成瞬间完成的普通 tool call，因为只有客户端在握手时
声明私有 `cognition.ai/subagentSupport` 能力，它才发送结构化生命周期事件。Lody 现在对
`devin` 类型 agent 声明该能力位，并把生命周期 `_meta` 标记映射到现有的 `subagent_task`
管线。更难的点在于 subagent 内部更新该在哪一层拦下：非 tool 更新在通知入口处丢弃，tool
更新在历史 applier 中按既有条目裁决，这样 usage 计量、runtime config、plan 快照和
transcript 都保持干净，同时权限申请产生的 tool 行和文件编辑证据仍能正常闭环。该协议是
私有的、可能漂移，所以所有丢弃都以"已物化的 task 行/已知 task id"为前提，无法识别的输入
一律放行成可见输出。

## 问题

协商 `subagentSupport` 之后，Devin 在以 subagent agentId 为 `toolCallId` 的
`tool_call_update` 行上携带 `subagent_started`/`subagent_completed` 标记，并给 subagent
产生的每条更新（文本、tool call、usage 等）打上 `subagent_context` 标签（`parentAgentId`，
主 agent 为 `"root"`）。两个生产路径细节使得只在 parser 层做转换不够：

- `filterNotificationsForHistory` 会压缩掉没有 `rawInput` 的非终态 `tool_call_update`，而
  `subagent_started` 行恰好就是这种形状；现在对能解析为 Devin 生命周期标记的行同样豁免，
  与 `_meta.lody.task` 已有待遇一致。
- 同一条通知还喂给 transcript 之外的多个消费者——usage 计量、`config_option_update` 状态、
  plan 快照、会话标题、富文本附件——只在历史内容构造器里丢弃无法保护它们。

## 职责划分

- `AgentClient.sessionUpdate` 记录生命周期标记中出现过的 task id，并丢弃 owner 属于已知
  task 的 **非 tool** context 更新。这是 usage、config、plan、title、附件等消费者前方唯一
  的收口点。
- `buildMessageContentFromNotification` 把生命周期标记物化为 `subagent_task` 条目，并把
  生命周期行上的 context 标签读作 `parentTaskId` 用于嵌套。
- `NotificationOnHistoryApplier` 在 owning task 行存在后丢弃 context 更新，但 tool 更新若能
  并入已持久化条目则放行——权限请求会在工具执行前先写一条 pending `tool_call`，丢掉其
  终态更新会让该行永远 pending。
- `packages/shared/src/acp/devin-subagent-task.ts` 独占私有 wire schema；解析失败返回
  `null`，降级为普通 tool call。

## 备选与取舍

在入口丢弃全部 tagged 更新更小，但会回退两个今天正常的行为：批准的权限行永远不会完成，
subagent 的文件编辑会从 per-turn diff 中消失（编辑证据是对通知批的独立扫描）。另一种"盖
中性标记再逐消费者门控"的方案被否决，因为消费者清单不可枚举——任何未来新增或漏掉的消费
者都会静默泄漏。按层拆分（入口管非 tool、applier 管 tool 行）让每次丢弃都落在拥有相应状
态的那一层。

已接受的局限：subagent transcript 被丢弃而非嵌套——只保留完成时的 summary，与
Claude/Codex 任务面板现状一致。经权限批准的 subagent 工具会以无 parent 关联的扁平
`tool_call` 行出现，这是"用户必须看到自己批准了什么"的代价。fail-open 覆盖未知 owner id
和未识别标记；已知父 id 下发生协议语义漂移（比如新形状的嵌套生命周期行）仍可能被误判为
internal 而丢弃。`subagentControl`（取消控制面）不在本 PR 范围；任务面板的 cancel 按钮问题
先于本改动存在，且非 Devin 独有。

## 验证

parser 契约测试钉住抓包到的 wire 形状；applier 测试覆盖丢弃、未知 owner 的 fail-open、
权限行合并、嵌套 `parentTaskId`、未识别标记直通；管线测试证明 started 行能穿过历史过滤
并落为 `subagent_task`。shared 与 CLI typecheck 均通过。未验证：抓包握手与生命周期序列之
外的真实 Devin 流量，以及 Devin 的 `subagents/*` 控制方法。

PR: https://github.com/LodyAI/Lody/pull/767 （关闭 #765）
