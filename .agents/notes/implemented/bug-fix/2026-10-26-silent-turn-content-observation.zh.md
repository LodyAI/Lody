# 将回合内容与 ACP 重放证据分开

Status: implemented
Translation: current
Issue: [#436](https://github.com/LodyAI/Lody/issues/436)

[English](2026-10-26-silent-turn-content-observation.md)

## 摘要

结算与提示重放共用任意 update 的观测，导致会话 metadata 让空 Agent 回合被判成功。
MessageHandler 现在在 enqueue 时把内容事实写入现有回合 owner，跨 flush 保留，同时
继续用任意事件保守地阻止重放。空或仅 metadata 的完成记录 `agent_no_output`，推进已
送达输入的指针并发布失败结果。夹具覆盖真实本地执行与历史边界；尚未验证真实 provider
及打包桌面端。

## 决策与 provider 契约

Issue 中的[参考分支评论](https://github.com/LodyAI/Lody/issues/436#issuecomment-5935995345)
指出需要两类观测，但也把 checklist plan 与子 agent 生命周期算作内容。本实现遵循消费端契约：

| 收到的更新 | 内容结算 |
| --- | --- |
| 非空白助手文本或思考 | 算内容；思考在历史中可展开。 |
| 根助手 image/audio/resource/link | 算内容；MessageHandler 先物化附件再写历史。非文本思考没有对应历史项。 |
| 带 ID 的工具调用或稀疏工具更新 | 算内容；无最终正文也会形成工具行，失败工具仍有可观察行为。 |
| `plan` / `plan_update(items)` | 仅 checklist/状态，包括非空 checklist。 |
| `plan_update(markdown)` | 非空白时算内容：可阅读的方案历史项。文件方案、删除及空 markdown 不构成内容。 |
| 子 agent 事件 | snapshot/progress 是生命周期状态。子文本/思考/工具输出算内容；子富内容目前仅标记不完整。 |
| 配置、模式、命令、标题、usage、用户回显 | 不算 Agent 内容。 |

这是协议内容观测，不证明下游存储成功或工具效果完成。flush 失败仍由原错误/重试 owner
处理。锁定的 Claude 适配器在普通文本中发送思考标签，并发送 checklist plan；Codex 的
`CodexPlanStream` 与 Grok 的 `plan-review.js` 可发送 markdown 方案或回退为普通文本。
Core 将子输出与生命周期快照分开；Kimi 已记录的能力是主 agent 任务快照与最终尾部输出，
并非实时子增量。不需按 provider 名称增加例外。参见[共享 reducer](../../../../packages/shared/src/acp/history-apply.ts)、
[附件物化](../../../../apps/cli/src/lib/acp-agent-attachments.ts)和
[provider 证据](../../proposed/architecture/2026-09-26-subagent-events.md)。

## 所有权与故障隔离

触发条件是 prompt 正常返回却没有内容。`TurnPhase.hasVisibleOutput` 属于精确 epoch，
初始为 false，随回合消失；enqueue 在设置前检查已绑定目标的 epoch。因此不需第二套
registry、保留策略或 flush 时扫描。原生重放抑制先执行；已结束回合的迟到输出不能让
新回合成功。

`hasPromptEventsForTurn` 保留任意 ACP update 的缓冲/已 flush 证据；状态缺失或未接入
observer 时拒绝 stale 重放。内容观测对缺失/不匹配 owner 返回 unknown，结算保守放行。
已知静默回合正常 finalize、记录可见失败，只推进已送达输入的终态指针。正常返回的
prompt 不会被重试。普通断线回合仍只在任何事件之前允许一次重试；Inbox 保留不重放边界。

取消、原始请求 drain、实例退休、presence 释放和 flush 恢复仍由现有 owner 负责。
内容失败不新增等待、资源或 teardown fence。
[退休决策](2026-10-17-stale-acp-recovery-turn-ownership.md)继续约束替换与释放失败。
Effect 4.0.2 feature/fix 评估保留同步观测为普通代码：迁移 MessageHandler 会拉入尚未完成
的 Session/history 依赖链。本次不改变 native 边界、依赖、消费者或 unit ledger 事实。

## 验证与简化

Owning ACP batching 与 execution suite 使用 synthetic provider/Git 输入，连接真实
Session/SessionManager/MessageHandler、离线 SessionDocument、native presence 和显式
完成信号。断言历史终态、失败 notice、结果事实、提交输入与释放后的所有权。场景包括
flush 前后 metadata、无事件、空与可见内容、仅工具/失败工具、plan 变体、子内容/状态、
下一回合隔离、重放抑制、不可观测状态和已有 Stop/退休/重试失败路径。

原任意 update observer 让仅 metadata 验收以 `handled` 而非 `failed` 失败；恢复后同两组
suite 的 376 个用例全部通过。临时简化得到以下行为失败：

| 移除的设计 | 失败用例 |
| --- | --- |
| 独立内容观测，改用任意事件结论 | 16：metadata/空内容/checklist/生命周期被判成功。 |
| 回合 latch，只看待 flush 的 buffer | 3：已 flush 内容消失，包括成功的 stale 恢复。 |
| 目标 epoch 检查 | 1：旧回合输出污染新回合。 |
| unknown 状态的保守重放策略 | 2：缺失观测允许重放。 |
| 子富内容排除 | 1：不完整标记被判为成功输出。 |

所有临时撤回已恢复。设计只保留一个回合布尔值和一个私有分类函数，没有导出 helper、
Service、Layer、map、timer 或新恢复路径。Node 26.12.1 下 `pnpm format`、CLI 类型检查、
`check:quick`（含 Effect/public 边界）与 `docs check` 通过。根 `pnpm check` 到达 CLI 测试
（4,685 个通过），但未改动的 Git 身份相对 global 夹具失败；单独运行也读到本机 owner
身份而失败。这不代表全仓检查通过。实际验收截图和原始消融证据归 draft PR，不使用
真实用户 transcript 作为夹具。
