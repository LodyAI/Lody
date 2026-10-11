# DSH 0.2 工具结果投影回归

Status: implemented
Translation: current

[English](2026-10-10-dsh-tool-result-format.md)

Provider PR: [acp-extension-dsh #30](https://github.com/LodyAI/acp-extension-dsh/pull/30)

## 摘要

Harness 0.2.0-rc.2 升级改变了原生工具结果消息，但 ACP adapter 仍校验旧版的
嵌套块格式。因此合法文本结果也会投影失败，即使原生执行完成，轮次结算仍报
`assistant output delivery failed`。provider bridge 及测试数据现已对齐固定
版本的原生契约，回归覆盖实时结算和历史重放，并用真实原生构造函数探针防止
合成测试数据继续沿用过时格式。

## 证据与职责

- 本机发布包 `@deepseek-ai/dsh-llm` 0.1.5-rc.2 的 `createToolResultMessage`
  创建 user 消息，其内容包含 `type: 'tool-result'` 块，`toolCallId`、`content`
  和 `isError` 位于块内。
- 固定版本 0.2.0-rc.2 的同名函数改为创建 `role: 'tool'` 消息，`toolCallId`、
  `content` 和 `isError` 直接位于消息层。content 包含普通文本或图片块，source
  标识对应调用。
- [ToolCallBridge](../../../../packages/acp-extension-dsh/src/tool-calls.ts)
  此前将 `message.content` 解析为旧结果块数组。将真实 0.2.0-rc.2 构造函数生成的
  合成文本结果送入该 schema，可复现 `message.content[0]` 的三个错误：type
  不匹配、缺少 toolCallId、缺少嵌套 content。
- [Adapter 输出交付](../../../../packages/acp-extension-dsh/src/adapter.ts)
  将投影异常记入 `inflight.outputError`，输出队列完成后拒绝 prompt。因此用户
  已收到最终回答与 ACP 轮次报错可以同时发生。已记录原生结果的工具也会因投影
  未结束而被标记为结果未知。
- [历史重放](../../../../packages/acp-extension-dsh/src/session-history.ts)
  同样调用该 bridge。现有
  [adapter 测试](../../../../packages/acp-extension-dsh/src/adapter.test.ts)
  此前构造旧的嵌套结果，掩盖了不兼容。

这是[Harness 升级](../feature/2026-10-09-dsh-harness-upgrade.zh.md)
遗漏的契约边界。[工具可见性 Spec](../../../../specs/deepseek-harness-tool-calls.zh.md)
已要求结果可见，无需改变产品意图。

## 修复与验证

bridge 在消息层解析 `role: 'tool'`、`toolCallId`、`content` 和可选 `isError`，
并在原始输出中保留原生消息字段及事件 metadata。无效结果仍会明确导致交付失败。
原生 `dsh-session-format-v3-to-v4` 将旧 user-role 包装转换为 tool-role 消息，
因此 adapter 不引入第二套旧格式路径。

所属 adapter 测试中的成功/失败结果、metadata、图片、会话隔离及重放均已使用
新格式；新增 prompt 级回归覆盖成功、工具失败、空内容以及无效结果。已有 Core
能力原生探针增加通过真实 0.2.0-rc.2 `createToolResultMessage` 构造消息并验证
bridge 终态输出的检查。所有测试数据均为合成数据，不包含捕获的会话文本。

独立 provider 克隆中的 `npm run build`、61 项单测、`npm run format:check`
及两项真实运行时 Core 能力探针均通过。三项新增合法结果 prompt 回归在原 bridge
上均失败。根 `pnpm check` 和 `pnpm format` 已尝试，因 worktree 缺少依赖
（adapter TypeScript 依赖及 Oxfmt）停止。根 docs check 仍报告未初始化的其他
子模块链接错误，两份新增记录均无错误。未测试真实模型调用或桌面打包。
