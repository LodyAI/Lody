# Codex 分模型用量归因

Status: proposed
Translation: current

[English](2026-09-15-codex-per-model-attribution.md)

## 摘要

Codex 的 thread 总量此前没有模型归属，因此用量界面只能显示不透明的
`codex:unattributed` 桶。锁定 runtime 还会发送精确的单次 completion 用量事件；
适配器现在会把这些事件归到已解析的模型，只把未覆盖的余量保留为未归属，并在
resume 时恢复一个小的累计 sidecar。审查后的修复为新 thread 开启 raw 事件，
在付费请求前捕获 fork 历史，并持久化 native reset 游标。冷 resume/fork 以及
模型不明确的压缩/reroute 响应保持未归属，因为锁定协议无法确认其实际模型。

## 背景

Codex app-server 的 `thread/tokenUsage/updated` 只有 thread 级累计值，没有
model 字段。适配器过去把全部总量放在 `codex:unattributed`，因此 AI 用量页面
无法把 Codex token 归到实际产生它们的模型。

## 修正

锁定 Codex 0.153.4 可以为每次上游 Responses API completion 发送
`rawResponse/completed`。它的 `usage` 是精确值，不累计也不 replay，`responseId`
可用于幂等去重。适配器现在把这些事件归到已解析的 thread/turn 模型。任何没有被
精确事件覆盖的 thread 总量仍留在 `codex:unattributed`，因此旧 runtime 或无法
解析模型时，总量仍然正确，而不是伪造一个模型。

适配器为新 thread 开启 `experimentalRawEvents`。此版本的冷 resume 和新 fork
listener 没有相应开关，使用未归属的累计用量。压缩可能使用旧模型或 fallback，
其 raw 响应也保留未归属。reroute 证据仅适用于紧随其后的 raw completion，
包括不含 usage 的 completion；再之后的响应保持未归属。

适配器在 `$CODEX_HOME` 下保留小的累计 sidecar，恢复模型账本时一同恢复 native
total、reset offset 和 reset 标记。fork 等待 native `thread/started`，该信号
位于历史 usage 通知之后；接收 prompt 前持久化准确的源基线。空历史为零，
绝不用首次付费响应推测源历史。
sidecar 不是投递账本；CLI 仍会重试自己的累计快照。CLI 不再为 legacy adapter
从当前 UI 选中模型合成 `modelUsage`；缺失归因时直接跳过。

## 限制

- sidecar 是机器本地的。恢复一个 exact-attribution thread 时如果 sidecar 丢失，
  新进程可能把历史 token 当作未归属。长期方案仍然是消费者侧持久的 accounting
  identity。
- `rawResponse/completed` 在锁定 runtime 中是内部 app-server 事件，需要像生成的
  客户端类型一样遵守版本/能力约束。
- Subagent thread 有 `thread/settings/updated` 时使用自己的模型；否则其精确响应
  会回落到 `codex:unattributed`。child native 总量包含继承历史，reset 也独立，
  所以主账本只纳入 child 的精确响应；缺少这些事件的 child 活动无法计量。
- 缺少 native 游标的旧 sidecar 会锚定到捕获的 native 历史回放；此迁移不能重建
  已经遗漏的历史用量。

## 证据

### 审查与消融（2026-09-16）

完整审查 adapter PR [#45](https://github.com/LodyAI/acp-extension-codex/pull/45)
的 `94f51b7` 和 Lody PR [#736](https://github.com/LodyAI/Lody/pull/736) 的
`bb0052d8`：无 P0，CLI 删除 fallback 未发现新增 P1。以下 adapter 发现描述的是
当时被审查的版本，也是上文修复的依据：

- 锁定 `rust-v0.153.4` 在 thread 未开启 `experimentalRawEvents` 时过滤
  `RawResponseCompleted`。adapter 没有开启；initialize 的 `experimentalApi`
  不够，native resume/fork listener 也使用 false。因此 fork 首次 total
  会把首次新增 response 一起排除。
- fork 在任何 usage 前打开并恢复，会丢失内存中的 pending exclusion。
  合成场景中源历史 900 input / 100 output 被计入恢复后的 child，预期为零。
- native-only 计量的 reset 游标未持久化：1000、reset、10 得到 1010；
  重启后 native total 为 20 时仍输出 1010，而非 1020。
- 仅开启 raw 仍不足以修复模型归因：native previous-model inline compaction
  使用新 turn ID 和旧模型，turn 级模型映射会把该响应归到新模型。

native 源码确认 raw completion 先于对应 total；adapter 通知队列串行处理。
原有 subagent 共用 total/reset 状态现已与主游标隔离。主线程精确用量会作为 pending
持久化，直到 native 总量覆盖它，包括在相应 total 处理前重启并回放 reset 的情况。
消费端 accounting identity 限制仍不属于本次 adapter 修复范围。

逐项消融删除了仅转发构造的 factory 和第二次模型名 trim。打包后的合成场景输出，
包括 sidecar 持久状态，完全一致。删除 response 去重使重复的 110-token 响应计为
220，因此已恢复。删除 CLI 模型字段投影会暴露模型级 contextWindow 和未知字段，
因此保留。没有证据支持继续删除 CLI 运行时代码。

初次消融已执行 esbuild 0.25.12 计量打包与合成场景：互斥分桶、重复响应、模型切换、
subagent 模型、native reset、返回值修改隔离、fork/resume。完整检查与 Vitest
已尝试，但缺失 workspace 依赖，无法完成；未运行真实 Codex 会话、Windows
文件系统或进程崩溃注入。仓库文档检查还报告现有 CLI agent AGENTS.md 超限。

修复验证使用隔离依赖、Codex 0.153.4 和 Vitest 4.1.11：639 个测试通过，
27 个 E2E 测试跳过；adapter、examples 类型检查与正式 build 通过。覆盖旧 sidecar
两种迁移、fork 回放、reset/pending-response 重启组合、child 游标隔离及原子替换
失败。独立复审未发现修复中残留的 P0/P1。未执行付费模型 completion 或真实进程
崩溃注入。外层完整检查和格式化仍受其他缺失依赖阻塞；docs check 仍报告 CLI
agent AGENTS.md 超限。两个 gitlink 均不提交。

- `src/CodexUsageAccounting.ts`
- `src/CodexUsageBaselineStore.ts`
- `src/CodexEventHandler.ts`（`rawResponse/completed`、`thread/settings/updated`、
  `model/rerouted`）
- `src/__tests__/CodexACPAgent/token-usage-events.test.ts`
- `apps/cli/src/agent/agent-client.ts`（不再回落到 UI 模型）
