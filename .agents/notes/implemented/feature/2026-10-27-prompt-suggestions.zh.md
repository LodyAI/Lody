# 统一 ACP 下一条提示建议

Status: implemented
Translation: current

PRs: [Lody #1951](https://github.com/LodyAI/Lody/pull/1951), [Core #24](https://github.com/LodyAI/acp-extension-core/pull/24), [Codex #75](https://github.com/LodyAI/acp-extension-codex/pull/75), [Claude #44](https://github.com/LodyAI/acp-extension-claude/pull/44)

[English](2026-10-27-prompt-suggestions.md)

## 摘要

Core 新增经过协商的下一条用户提示预测通知，Codex 和 Claude adapter 已转发原生事件。Codex 保留来源 turn 与成功／空结果／失败；Claude 保留建议文本和消息标识，不虚构来源 turn。用户接受过期建议，随后授权实现 Lody 同步与 composer 集成。Lody 通过独立 ephemeral 通道交付最新参考建议；桌面 Tab 与移动端“应用”将它填入可编辑草稿，不自动发送。Codex 0.164.0 虽定义预测协议，但请求处理尚未实现，该运行时无法通过此路径生成原生预测；Claude 真实模型端到端交付仍未验证。

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
  源码。Core 0.3.0 已发布，两个 adapter 均精确依赖 `acp-extension-core@0.3.0`，
  npm 生成的 lockfile 包含对应注册表校验值。根 lockfile 因 workspace 覆盖不变。全部 8 个 submodule 已对齐拉取时的上游 main，包含 Core 0.3.0 发布提交；Codex 调试结束后恢复 main 提交 `304d594`，托管运行时版本锁定不变。
- 建议使用独立 `prompt-suggestions` ephemeral 通道，不进入 presence 心跳和持久化历史。发布端最多保留 256 个会话条目、24 小时，文本上限 16,384 字符，身份字段有长度限制。这是传输保留时间，不是 turn 新鲜度规则。
- CLI 仅接受已协商且属于当前 ACP 会话的通知，再映射到稳定 Lody 会话及机器。现有物理写入器向本地连接合并发送最新快照。可选云桥接沿用既有授权并排除加密工作区；纯本地组合不启动云传输。
- Renderer 分离本地与云端 store，按目标机器选择来源，未知路由不显示建议。hook 防止 workspace/runtime/session/machine 切换串数据。输入、清空和接受都不消费共享建议；空结果或失败清除可见提示。参见 [composer 交互契约](2026-10-27-prompt-suggestion-composer-ui.zh.md)。
- 现有原生传输和写入器继续负责生命周期，本次未扩大 Promise 集成边界的迁移范围。

## 验证

Core build/typecheck 与全部 10 项测试通过。adapter 测试覆盖未协商／未知版本、启用生成
与显式关闭、文本／null／失败保留、会话隔离与原生到 ACP 标识映射、prompt 完成后交付，
以及旧 Claude 建议发送失败时新 prompt 仍能完成。Codex 覆盖两个 ACP 版本。
最终离线测试：Claude 1,172 项通过、11 项跳过；Codex 98 项通过。Node 24.22.1 下两个 adapter 构建、Codex typecheck、Claude 修改文件 lint/format 检查通过。

Core 0.3.0 在干净的独立 adapter 克隆中使用 `npm ci` 验证：Codex 类型检查、构建和 11 项定向测试通过；Claude 构建、check 和 699 项定向测试通过（10 项跳过）。真实模型生成和抑制行为仍未验证。

合并 main 后，Lody 的 46 项 CLI、21 项共享边界及 80 项 renderer/composer 测试通过；扩展后的 6 项建议测试也通过，覆盖 sheet 接受和禁用时保留焦点。此前共享包全量 1,688 项测试通过。合并 main 前 shared、CLI、components 类型检查通过；合并后 components 类型检查因已安装的 Streams 依赖缺少 main 的 `onSnapshotRecovery` 补丁阻塞，相关 E2EE 消费代码与 main 一致。根格式化和文档检查通过。根 `pnpm check` 在 Devin adapter 准备阶段因该 checkout 缺少依赖阻塞，不能视为全仓检查通过。根 lint 也遇到其他 checkout 范围缺少 Node/React/Vite 类型定义。Storybook 浏览器检查覆盖桌面 Tab、移动端应用、输入隐藏与清空恢复，控制台无错误；数据为合成组件输入，并非真实模型或完整应用会话。

## Codex 运行时可用性纠正

存在预测 schema 不代表发布的运行时会产生预测。准确版本 `rust-v0.164.0` 将 `thread/prediction/request` 直接返回 method-not-found，消息为 “thread/prediction/request is not implemented yet”；该版本源码只有通知定义，没有生成发送点。对 Lody 本机安装的 Codex 0.164.0 做隔离探测，在 `experimentalApi: true` 初始化后，请求返回相同消息和错误码 `-32601`。探测使用合成 thread/turn ID、临时 Codex home，没有发起模型 turn，也未复制用户会话或凭据。

本机诊断日志显示 v1 协商成功、prompt 正常完成，但没有原生预测接收记录；已核对正在运行的打包 adapter 包含诊断代码。这解释了转发测试通过而输入框没有建议。协商说明 adapter 能转发此契约，不证明原生运行时具备生成功能。不能将这种静默判断为模型返回空建议或主动抑制；不要猜测开关，也不要自动调用尚未实现的请求。升级前需验证新运行时的实际支持；自行额外调用模型预测则是独立的产品和费用决策。

证据：[0.164.0 请求分发](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/message_processor.rs#L1482)、[协议类型](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/thread_prediction.rs)。

## 消融审查

各候选项单独删除并验证后，再进行组合回归。保留以下精简：

| 删除候选 | 冗余原因 | 行为证据 |
| --- | --- | --- |
| Renderer 的 `onJoined` 覆盖 | 基类默认调用 `onStoreChange` | 云端 bootstrap 能交付建议，本地／未知路由不回退到云端 |
| hook 对 session atom 的 `useMemo` | `sessionMetaAtomFamily` 已按 key 缓存 atom | 切换会话／工作区仍清除旧订阅与建议 |
| 接受建议时第二次禁用检查 | 禁用 composer 已无可见建议 | 保留焦点的禁用输入保持为空，移动端应用和桌面 Tab 仍能接受 |
| 独立 memoized 键盘回调 | 唯一调用方是每次新建的输入处理函数 | 合并后仍保留修饰键、IME、焦点、sheet 和提交行为 |

负对照：删除发布器禁止远端写回的 adaptor 后，既有隔离测试在本地快照读到 `foreign`，因此恢复并保留该边界。未删除所有权、重连、保留上限、身份或光标保护。Renderer 测试在连续写入间显式推进假时钟，不依赖真实毫秒流逝。新增云端 bootstrap 用例验证继承的交付行为，没有新增源码字符串或仅检查调用次数的测试。

组合回归：82 项 renderer/composer、46 项 CLI 和 21 项共享边界测试通过，共 149 项。改动文件 lint 无错误，格式化和文档检查通过；全仓检查仍受 Devin 依赖缺失阻塞，components 类型检查仍受本地 Streams 补丁类型缺失阻塞。

## 证据

- [Core 契约与协商](../../../../packages/acp-extension-core/README.zh.md#下一条提示建议)。
- [Codex 事件 schema](../../../../packages/acp-extension-codex/src/app-server/v2/ThreadPredictionUpdatedNotification.ts)、[结果 schema](../../../../packages/acp-extension-codex/src/app-server/v2/ThreadPredictionResult.ts)及[映射](../../../../packages/acp-extension-codex/src/CodexEventHandler.ts)。
- [Claude 映射与原生选项](../../../../packages/acp-extension-claude/src/acp-agent.ts)，锁定 SDK 0.3.293：建议在 result 后发送，设置、plan mode、首轮、错误和额度均可能抑制生成。

使用助手文本会污染历史；强制来源 turn 与 Claude 缺失原生字段冲突；折叠空结果与失败
会丢失 Codex 语义。用户选择宽松参考性交付，不继续调查 Claude 的跨轮来源关联。
