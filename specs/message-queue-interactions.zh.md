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

  `session/queue-steer` 与 `session/queue-mutate` 在写入远程请求前，必须共用 source-side
  session 控制授权。Session metadata 必须匹配目标 machine；控制必须具备当前已认证的
  machine 访问权限，local-project session 还必须具备对应项目权限。控制策略独立于 UI
  visibility：创建 session 不授予控制权，也不能绕过权限撤销，即使 UI 仍显示该 session。
  Metadata 缺失或授权快照
  不完整时 fail closed，绝不降级成 machine-only 检查。
  请求不得携带请求者身份：workspace Machine RPC 无法认证调用方
  声称的成员 ID，目标 daemon 也不得用它命中 owner fast path。同机 local IPC 已是可信的
  本地控制边界。
  先确定 routing plane，再检查 transport：local 缺少 sender 返回本地传输错误，路由未确定
  则返回路由错误。两者都不得创建 Streams client 或追加远程请求；传输失败不能改变已选 plane。

  Native 精确“引导”的 requester identity 必须来自已认证的活动 invocation，绝不来自共享
  queue row。若该冻结身份不可用，daemon 必须在消费 row、提交 provider 或停止 turn 之前失败。

  Native Steer reservation 成功后，所选项的 ownership 从共享可编辑 Queue 转移到
  daemon-owned Steer operation。此后普通 edit、remove、reorder 和队列 promotion 都不得
  修改或消费它，即使其他客户端仍显示旧 row。reservation 与普通修改必须共享权威 ownership
  边界：编辑先提交则已保存内容进入验证快照（或令 reservation 拒绝）；reservation 先成功则
  后续修改须明确拒绝。被拒绝的编辑保留用户草稿。乐观 UI 成功或客户端本地 editing lease
  都不证明权威写入端已接受编辑。

  `queueItemSteer` v2 通过 `session/queue-mutate` 建立该保证：renderer edit/remove
  携带观察到的 row revision，reorder 携带观察到的 ID 顺序。所属 daemon 在 reservation
  边界内比较，并在已接受修改持久化后回复。RPC 失败绝不退回直接写 CRDT。
  enqueue 和普通发送仍由 renderer 写入；这不是通用 write-intent 协议。

  Native 提交顺序为：
  1. 验证目标标识、内容、编辑归属和 expected turn，并针对并发普通队列修改取得排他 reservation
     ownership。
  2. 持久化 daemon-owned reservation marker。
  3. 将冻结 turn 追加为 `pending_apply`，并确保 history 持久化。
  4. 从共享 Queue 删除所选 row，并确保删除持久化。
  5. 调用 `ActiveTurnSteerPort.prepareSteer` 构建 prompt、按需应用 mode/model 并重新验证
     ownership。准备过程不提交 steer，仅返回不透明 handle。
  6. 持久化 write-ahead `submitting` 证据后，将 handle 交给 `submitSteer`。此时不再等待
     prompt 构建或配置应用；port 在 provider 提交前立即再检查 ownership，阻止持久化期间
     的 Stop 导致过期提交。

  准备失败可将冻结 turn 恢复为普通 dispatch，不写 `submitting` marker。Provider call
  的普通异常（包括同步连接失败）属于交付不确定；只有明确证明未交付的拒绝才可 fallback。
  不得将 PersistenceFailure 一律转为 fallback。Prepared handle 仅在进程内单次使用，
  不是新的持久 phase；write-ahead marker 与 provider call 之间的 crash gap 仍存在。

  reservation、history 或删除任一持久化失败，都禁止提交 provider。网络调用前删除 row
  是必要条件，但不能替代步骤 1–4 期间的 ownership 边界。Native 恢复依赖 machine-local
  marker 与冻结 history，不再拿可编辑 queue row 当 retry token。`reserved` marker 没有
  history 时属于未提交：恢复清除 marker，保留剩余 row，不生成终态 receipt。同一个 queue
  item/expected turn 可立即重试，包括继续当前请求，但必须重新读取并验证 queue 和 live turn，
  建立新的 reservation。Marker 清理失败时不得继续重试。history 持久化后，恢复可完成删除并
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

[Effect 边界决策](../.agents/notes/implemented/architecture/2026-09-14-queue-steer-effect-boundary.zh.md)
记录已实现的 service/port 拆分、v2 修改权威、提交前持久化删除、仅按 capability 开放能力及验证限制。
确定性测试覆盖 reservation 与第二客户端修改、草稿保留、持久化失败和 marker 恢复。
真实 provider、已安装应用及进程 kill 的端到端验证尚未完成。
新的可用性策略只适用于队列行“引导”，不改变 composer 提交路由。

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/`
- `packages/components/tests/{session-message-submit-route,session-chat-input-submission,message-queue-row-editing}.test.*`
- `apps/cli/{tests/session-execution-service.test.ts,src/lib/loro/doc-user-turn.test.ts,src/session/session-queue-steer-operation-store.ts}`
- `apps/cli/src/session/{queue-steer-service,active-turn-steer-port}.ts`
- [决策记录](../.agents/notes/implemented/feature/2026-09-13-queue-steer-controls.zh.md)

这是供人工审阅的草稿；实现和测试通过不代表 Spec 已获批准。
