# 消息队列交互

Status: draft
Translation: current

[English](message-queue-interactions.md)

## 场景

用户在 Agent 工作时继续输入，并将“排队”或“引导”设为默认行为。他们可能只想让某一条
消息采用相反行为，也可能希望直接用任意一条已排队消息引导当前回复，而不必先手动调整队列。

## 契约

- `Mod+Shift+Enter` 以已保存“排队／引导”偏好的相反行为发送当前草稿。这是一次性的提交
  意图：命令直接为本次提交传入 `queueBehavior: "inverse"`，普通 Enter 不传覆盖项。它不
  修改设置，并继续遵守普通的可用性、实时活动和未完成消息记录保护。输入框聚焦、有内容且
  可以发送属于命令本身的可用条件，因此用户重绑快捷键后仍受同一限制。
- 精确队列项引导是版本化 daemon workflow。只有
  `MachineMeta.protocolCapabilities.queueItemSteer` 声明受支持版本时，Renderer 才能调用
  `session/queue-steer`；缺少 capability 即表示不支持。请求携带持久队列 ID 和预期活动 turn，
  具体执行方式由 daemon 而非 Renderer 决定：

  | 当前 daemon/runtime                                      | 引导行为                                                                                              |
  | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | 支持精确队列项协议，且支持 acknowledged native ACP Steer | 将目标移交 daemon-owned operation，持久化 `pending_apply` history 与队列删除后，再调用 native Steer。 |
  | 支持精确队列项协议，但不支持 native ACP Steer            | 将目标行持久化并激活为下一用户 turn，从队列删除后再只停止预期 turn。                                  |
  | 未声明受支持的 `queueItemSteer` capability               | 所有行的队列“引导”均不可用，包括队首；不因 native ACP capability 而例外。                             |

  队列“引导”不提供旧 daemon 兼容路径：不允许 renderer 写历史、legacy native Steer 或
  队首取消。UI 只暴露一个精确队列项 operation，不选择 provider 交付方式。
  从 `[A, B, C]` 通过精确协议选择 C 时，只消费 C，
  剩余队列保持 `[A, B]`。

  `QueueSteerService` 负责精确选择、验证、持久恢复证据、fallback 策略和结果/回执。
  `ActiveTurnSteerPort` 负责 live turn ownership、native provider 提交、prompt handoff
  以及与 Stop 的串行化。队列 operation 不得访问 runtime map 或 provider client，接收
  领域结果而非 phase callback。本地 ownership guard 可作为 scope 资源；provider 提交是
  不可撤销的外部副作用。只有证明未交付且 operation 前提仍成立时才有资格 fallback。
  交付不确定须向上传递，禁止 replay；本地失败依据 durable evidence 恢复，不能仅凭本地
  失败推断未交付。

  远程 Renderer 在写入请求前，必须使用其已认证的权威 machine-access 快照验证目标；快照
  不可用时应 fail closed。请求不得携带请求者身份：workspace Machine RPC 无法认证调用方
  声称的成员 ID，目标 daemon 也不得用它命中 owner fast path。同机 local IPC 已是可信的
  本地控制边界。

  Native 精确“引导”的 requester identity 必须来自已认证的活动 invocation，绝不来自共享
  queue row。若该冻结身份不可用，daemon 必须在消费 row、提交 provider 或停止 turn 之前失败。

  Native Steer reservation 成功后，所选项的 ownership 从共享可编辑 Queue 转移到
  daemon-owned Steer operation。此后普通 edit、remove、reorder 和队列 promotion 都不得
  修改或消费它，即使其他客户端仍显示旧 row。reservation 与普通修改必须共享权威 ownership
  边界：编辑先提交则已保存内容进入验证快照（或令 reservation 拒绝）；reservation 先成功则
  后续修改须明确拒绝。被拒绝的编辑保留用户草稿。乐观 UI 成功或客户端本地 editing lease
  都不证明权威写入端已接受编辑。

  Native 提交顺序为：
  1. 验证目标标识、内容、编辑归属和 expected turn，并针对并发普通队列修改取得排他 reservation
     ownership。
  2. 持久化 daemon-owned reservation marker。
  3. 将冻结 turn 追加为 `pending_apply`，并确保 history 持久化。
  4. 从共享 Queue 删除所选 row，并确保删除持久化。
  5. 持久化 write-ahead submission 证据，再将冻结 turn 传给 `ActiveTurnSteerPort.steer`。
     port 在提交 provider 前重新验证 live turn ownership。

  reservation、history 或删除任一持久化失败，都禁止提交 provider。网络调用前删除 row
  是必要条件，但不能替代步骤 1–4 期间的 ownership 边界。Native 恢复依赖 machine-local
  marker 与冻结 history，不再拿可编辑 queue row 当 retry token。若在 history 持久化前
  崩溃，须先将 reservation 对账为未提交，剩余 row 才能恢复可编辑；不得把旧客户端编辑
  报成保存成功，也不得从后来的 queue 内容构建 turn。history 持久化后，恢复可完成删除并
  恢复同一个 turn，无需 row 仍存在。新的缺失 row 请求仍失败；同一 reserved operation
  的重试通过 marker 或 receipt 解析。

  Native handoff 在存储与 provider 副作用之间仍非原子操作。已有 machine-local marker
  记录 `reserved`、write-ahead `submitting`、provider `acknowledged`、本地已提交
  `applied` 或 `fallback`，须继续支持其恢复。已进入 history 的 `reserved` 或 `fallback`
  可在队列删除持久化后转为精确普通 turn。旧 operation 残留的 row 须在同一 ownership
  边界下对账，绝不能覆盖已接受编辑而盲目删除。`submitting` 结果不确定，
  `acknowledged` 可能已有 side effect，原 prompt owner 消失后两者都
  不得重放，而应落成可见失败。`applied` 证明本地 handoff 已完成，应恢复 accepted 回执，并由
  普通 crash handling 显示被中断的 turn。ACP 没有幂等提交键或交付查询，因此这里必须 fail closed。

  对 cancel-and-dispatch Steer，所选 queue row 是持久重试标记：先追加 history，再发布
  `latestUserMsgId`，且仅在两项写入都成功后删除 row。部分发布后的重试应复用已有 turn ID，
  不得重复追加 history。

- reservation 前，过期或冲突的精确“引导”选择必须失败且无副作用。所选 ID 已不存在、编辑 lease 仍有效，或
  预期 turn 已不再拥有执行权时，daemon 不得提交 native Steer，也不得停止任何 turn。Renderer
  等待确认，不自行移除队列项或为精确协议写历史。
- daemon 会按 session、预期 turn 和队列 ID，为最近已消费的精确请求保留有界内存 receipt；
  native saga 还会把最近一次最终回执保留在持久 marker 中，使 daemon 重启后的立即重试仍能
  返回原结果。后续 native 操作可替换该终态 marker。共享 Session metadata 可由协作者写入，
  因而不得作为恢复权威。若消费
  成功但取消失败，消息仍是持久 follow-up；receipt 仍保留时的重试不得复制它。Native 拒绝
  只有在 history 状态、activation pointer 和 queue row 清理都持久化后才能写入 receipt；恢复
  失败必须保持可重试。
- 序号和非编辑状态的消息正文共同组成队列重排拖动区域。“引导”、“编辑”和“移除”是独立
  控件，不能触发拖动。
- 未被 reservation 的 row 保留已有编辑键盘与焦点行为，并在编辑结束前禁用该行重排。
  reserved 项属于 operation，不再是可编辑队列内容；旧客户端的 edit/remove/reorder
  请求不得修改它，也不得静默成功。

## 边界与待审事项

只有“排队”和“引导”具有不同含义时，该快捷键才改变路由。空闲会话仍正常直接发送；没有
明确实时 prompt 活动时，即使反转意图是“引导”，也继续采用保守的排队屏障。触摸和鼠标共用
同一拖动区域；已安装应用和物理设备验证不由组件测试替代。Provider 未提供协议支持时无法
实现 exactly-once 恢复；结果不确定的 native 提交必须明确报错，绝不能静默重放。

## 实现证据

上述 service/port 拆分、reservation ownership 转移、提交前持久化删除队列项及仅按
capability 开放能力均是待实现的意图变更。当前 native 路径仍保留可编辑 row 直到 provider
handoff；普通 row 更新没有 operation ownership 检查，更新缺失 row 也可能静默成功。
因此已接受的编辑可能在 handoff 删除 row 时丢失。renderer 也仍包含旧 daemon 的
native/head 路径，execution service 仍拥有队列编排。实现及双客户端修改/崩溃回归验证
待按 [Effect 边界提案](../.agents/notes/proposed/architecture/2026-09-14-queue-steer-effect-boundary.zh.md)
完成。新的可用性策略只适用于队列行“引导”，不改变 composer 提交路由。

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/`
- `packages/components/tests/{session-message-submit-route,session-chat-input-submission,message-queue-row-editing}.test.*`
- `apps/cli/{tests/session-execution-service.test.ts,src/lib/loro/doc-user-turn.test.ts,src/session/session-queue-steer-operation-store.ts}`
- [决策记录](../.agents/notes/implemented/feature/2026-09-13-queue-steer-controls.zh.md)

这是供人工审阅的草稿；实现和测试通过不代表 Spec 已获批准。
