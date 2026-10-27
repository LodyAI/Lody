# 统一 ACP 下一条提示建议

Status: implemented
Translation: current

PRs: [Core #24](https://github.com/LodyAI/acp-extension-core/pull/24), [Codex #75](https://github.com/LodyAI/acp-extension-codex/pull/75), [Claude #44](https://github.com/LodyAI/acp-extension-claude/pull/44)

[English](2026-10-27-prompt-suggestions.md)

## 摘要

Core 新增经过协商的下一条用户提示预测通知，Codex 和 Claude adapter 已转发原生事件。Codex 保留来源 turn 与成功／空结果／失败；Claude 保留建议文本和消息标识，不虚构来源 turn。用户明确接受过期建议，并将本次实现限定为 Core 和 adapter。工作区集成已实现，独立包发布、Lody 同步与 composer UI 留待后续。

## 契约与映射

双方在能力对象 `_meta.lody` 下声明 `promptSuggestions: { version: 1 }`。
`_lody/session/prompt_suggestion` 通知携带：

```ts
type LodyPromptSuggestion = {
  sessionId: string;
  sourceTurnId?: string;
  suggestionId?: string;
  result:
    | { type: 'completed'; text: string | null }
    | { type: 'failed' };
};
```

Core 导出方法映射、类型、协商辅助函数和边界校验器。未知能力版本不视为已协商。
保留原文，包括空字符串。null 表示生成完成但无建议；失败只描述预测，不影响对话 turn。

Codex 将所属 `threadId` 映射为 ACP `sessionId`，保留原生 `sourceTurnId` 和 `result`。
沿用现有会话通知路径，在 prompt 释放后仍可交付，同时覆盖 ACP v1/v2。其他／子线程的
预测不会成为根会话建议。adapter 不请求生成，也不覆盖原生预测设置。

Claude 协商后开启 SDK `promptSuggestions`，但尊重 provider 选项的显式关闭。未协商时
不改变已有 provider 选项，也不发送 Core 建议。长驻消费者将 `uuid` 映射为
`suggestionId`、`suggestion` 映射为成功结果文本。检查 query 原生会话归属，并把重建后的
原生会话映射回稳定 ACP 会话。建议发送失败只记录诊断，不终止 query、不使后续 prompt
失败。没有新增重试队列、超时、turn ID 推断或新鲜度过滤。

## 决策和限制

- 用户接受可能过期的建议。Claude 省略 `sourceTurnId`，不新增 `validForTurnId` 或合成
  turn 绑定；消息 UUID 不是来源 turn。
- 通知只供参考，可以晚于 prompt 完成或新输入，不进入助手正文、不自动作为用户输入。
  没有历史／读取／重试 API，也不保证每轮必有事件；SDK 抑制生成不等于失败。
- 根 pnpm 工作区已有 `acp-extension-core: workspace:*` override，本地消费者使用本次
  源码。adapter 独立 npm 依赖尚不含新增 Core 导出，独立发布前须先发布 Core，再更新
  adapter 的依赖锁定和 lockfile。集成 PR 锁定供审查的源码提交；包版本、运行时版本和发布保持不变。
- 后续产品方向仍是 composer hint，Tab 接受为可编辑草稿但不自动发送。独立 ephemeral
  最新状态同步适合此场景；现有 `presence` 心跳通道不能承载建议文本。此次没有实现或
  验证 UI／同步。

## 验证

Core build/typecheck 与全部 10 项测试通过。adapter 测试覆盖未协商／未知版本、启用生成
与显式关闭、文本／null／失败保留、会话隔离与原生到 ACP 标识映射、prompt 完成后交付，
以及旧 Claude 建议发送失败时新 prompt 仍能完成。Codex 覆盖两个 ACP 版本。
最终离线测试：Claude 1,172 项通过、11 项跳过；Codex 98 项通过。Node 24.22.1 下两个 adapter 构建、Codex typecheck、Claude 修改文件 lint/format 检查通过。

仅因新增能力更新了两处 Claude 初始化快照。较大测试集发现九项已有 v2 task actor
快照差异，其中 `bash-background` 在未修改 adapter 源码下可复现。默认全量测试触发
已有真实运行时用例并访问网络、Codex 认证失败后已停止。真实模型生成和抑制行为仍未验证。
根文档检查仍有原有未展开子模块的断链；新增记录未引入链接错误（仍为基线 40 项）。

## 证据

- [Core 契约与协商](../../../../packages/acp-extension-core/README.zh.md#下一条提示建议)。
- [Codex 事件 schema](../../../../packages/acp-extension-codex/src/app-server/v2/ThreadPredictionUpdatedNotification.ts)、[结果 schema](../../../../packages/acp-extension-codex/src/app-server/v2/ThreadPredictionResult.ts)及[映射](../../../../packages/acp-extension-codex/src/CodexEventHandler.ts)。
- [Claude 映射与原生选项](../../../../packages/acp-extension-claude/src/acp-agent.ts)，锁定 SDK 0.3.293：建议在 result 后发送，设置、plan mode、首轮、错误和额度均可能抑制生成。

使用助手文本会污染历史；强制来源 turn 与 Claude 缺失原生字段冲突；折叠空结果与失败
会丢失 Codex 语义。用户选择宽松参考性交付，不继续调查 Claude 的跨轮来源关联。

创建 PR 时重新尝试了主仓 `pnpm check`／`pnpm format` 和 Claude `npm run check`；工作区依赖缺失、原有依赖软链接目标已不可用，因此未能重跑。上面的定向验证在环境变化之前通过。
