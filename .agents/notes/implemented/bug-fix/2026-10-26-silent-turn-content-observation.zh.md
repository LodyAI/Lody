# 将回合内容与 ACP 重放证据分开

Status: implemented
Translation: current
Issue: [#436](https://github.com/LodyAI/Lody/issues/436)
PR: [#1913](https://github.com/LodyAI/Lody/pull/1913)

[English](2026-10-26-silent-turn-content-observation.md)

## 摘要

结算与提示重放共用任意 update 的观测，导致会话 metadata 让空 Agent 回合被判成功。
现有回合 epoch 现在分别保留事件与内容事实，并覆盖图片生成的独立回调路径。ACP 内容
在 enqueue 时观测；生成图片只有匹配且非空的历史写入成功后才算内容，结算先等待现有
上传 owner。静默完成可见地失败且不重放，仅图片完成则可成功。Synthetic 测试覆盖本地
执行与存储；真实 provider 和打包桌面端尚未验证。

## 决策与 provider 契约

Issue 的[参考分支评论](https://github.com/LodyAI/Lody/issues/436#issuecomment-5935995345)
指出需要两种观测，但也把 checklist plan 与子 agent 生命周期当作内容。本实现遵循消费端契约：

| 收到的更新 | 内容结算 |
| --- | --- |
| 非空白助手文本或思考 | 算内容；思考在历史中可展开。 |
| 根助手 image/audio/resource/link | 算内容；MessageHandler 物化附件。非文本思考没有对应历史项。 |
| 图片生成回调 | 开始/状态/失败是事件证据；仅匹配且非空的 `image_group` 写入算内容。上传失败或拒绝附加不算。 |
| 普通工具调用或带 ID 的稀疏更新 | 算内容；无最终正文也形成工具行，失败工具仍有可观察行为。 |
| `plan` / `plan_update(items)` | 仅 checklist/状态，包括非空 checklist。 |
| `plan_update(markdown)` | 非空白时算可读方案。文件方案、删除及空 markdown 不构成内容。 |
| 子 agent 事件 | snapshot/progress 是生命周期状态；子文本/思考/工具算内容，子富内容目前仅标记不完整。 |
| 配置、模式、命令、标题、usage、用户回显 | 不算 Agent 内容。 |

ACP enqueue 观测不证明下游存储成功或工具效果完成；flush 失败保留原有错误/重试 owner。
图片生成的边界不同：AgentClient 在 `onUpdateMessage` 前拦截原始工具通知，改调
`onImageGenerationBegin/End`。对 `fa1e38ec4` 的独立 review 发现，尽管原 376 项测试通过，
已持久化的仅图片回复仍被判失败。只观测 enqueue 对内容与重放保护都不完整。Owning suite
现在驱动真实 AgentClient 路由、MessageHandler 上传管线与 SessionDocument 历史，不再把
旁路模拟成普通 ACP chunk。

Claude 在普通文本中发送思考标签及 checklist；Codex 的 `CodexPlanStream` 和 Grok 的
`plan-review.js` 可发 markdown 方案或普通文本。Core 将子输出与生命周期快照分开；Kimi
已记录的支持包括主 agent 任务快照与最终尾部输出，不包括实时子增量。分类不需新添按
provider 名称的例外。参见[共享 reducer](../../../../packages/shared/src/acp/history-apply.ts)、
[附件物化](../../../../apps/cli/src/lib/acp-agent-attachments.ts)和
[provider 证据](../../proposed/architecture/2026-09-26-subagent-events.md)。

## 所有权与故障隔离

`TurnPhase.hasPromptEvents` 与 `hasVisibleOutput` 属于一个 epoch，初始 false，随回合
消失。共享私有 recorder 先检查 epoch 与重放抑制，再更新事实。因此已缓冲/flush 的事件及
图片生命周期回调都阻止重放，但不等同内容。缺失状态或 observer 拒绝 stale 重放；缺失或
不匹配的内容观测仍为 unknown，结算保守放行。

现有图片 callId map 改为保存 begin 时的目标与 epoch，而不只是 turn ID。内联与文件路径
上传均把目标传到现有 append helper。成功且匹配的图片写入只为该 epoch 登记内容；复用
assistant ID 不能授权旧图片写入后继 epoch。迟到结果仍可写回原来的不同 assistant entry，
但不标记当前回合。不新增 map、timer 或资源 owner。

Prompt 返回后，内容观测先等待 `flushCodexGeneratedImageUploads`，再在回合状态仍归当前
owner 时读取。这是 finalization 已有的 drain 前移到判定之前，并非第二套恢复机制。两条
执行路径均通过已有 Effect Promise 边界等待。Stop 中断等待者；finalization 仍保留上传
owner，但仅在本轮共享截止时间内等待；超时或 shutdown 后释放 execution，上传可在后台完成并只写原 turn。失败/被拒上传保留原有捕获错误行为，
不登记成功。现有上传全部 drain 后才到达的事件仍使用捕获目标，不追溯修改已结算结果。

已知静默回合 finalize 后记录 `agent_no_output`，仅推进已送达输入的终态指针。正常返回的
prompt 不重放。普通断线回合仅在没有任何归属事件时允许一次重试；Inbox 保留不重放边界。成功发布仍遵循
[完成确认 owner](2026-10-26-turn-completion-signals.zh.md)；图片观测不绕过本地持久化或远端历史确认。
实例退休与释放失败继续遵循[退休决策](2026-10-17-stale-acp-recovery-turn-ownership.md)。
Effect 4.0.2 评估保留同步事实为普通代码并复用 native 执行入口；迁移尚未完成的图片、
Session、history 编排会扩大本 issue。不改变 native 边界或 unit ledger 事实。

## 验证与简化

ACP batching、execution、图片上传与 AgentClient 路由套件使用
synthetic provider/upload/Git 输入、真实本地历史及 native presence。显式信号覆盖上传尾部、
失败/被拒、仅开始/失败状态、上传中 Stop、迟到 end，以及不同 ID 和同 ID 新 epoch 下的
延迟写入。断言历史、终态、提交输入及保留/释放的所有权。独立 reviewer 原仅图片夹具也通过。

PR 保留真实 baseline/fixed 终端截图与原始命令。对同四套 suite 临时移除关键设计：图片写入
成功标记、观测前上传 drain、捕获 epoch、生命周期重放标记、匹配写入 guard、begin 目标
保留及无 owner 图片的独立 entry。这些移除分别产生 2、1、2、1、1、5、1 个失败用例；提交前恢复全部临时修改，不以源码字符串或 mock
次数断言替代。原缓冲/flush 推断重放的逻辑已删除，改用一个 epoch 内的事件事实；没有
投机 Service、Layer 或平行恢复流程。

使用 Node 26.12.1，不更改 floor 或依赖版本。根 `pnpm check` 通过类型/lint/Effect lint，
随后 CLI 4,697 个用例通过，一个未改动的 Git 身份相对 global 夹具在本机失败（另 4 项跳过）。
这不代表全仓通过。Scoped 检查和最新 CI 结果记录在 draft PR；不使用真实用户 transcript 夹具。
