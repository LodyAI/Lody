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

  | 当前 daemon/runtime                                                           | 引导行为                                                                          |
  | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
  | 支持精确队列项协议，且支持 acknowledged native ACP Steer                      | 将目标保留为 `pending_apply`，通过持久 handoff saga 后由 `steerPrompt` 注入。     |
  | 支持精确队列项协议，但不支持 native ACP Steer                                 | 将目标行持久化并激活为下一用户 turn，从队列删除后再只停止预期 turn。              |
  | 旧 daemon，但 authoritative capability 声明支持 acknowledged native ACP Steer | 保留旧版真正 native Steer 路径。                                                  |
  | 旧 daemon，且不支持 acknowledged native ACP Steer                             | 仅保留既有队首 interrupt 行为；禁用后续行“引导”，并要求升级 daemon 才能精确选择。 |

  任何兼容路径都不得先重排后续项再取消。从 `[A, B, C]` 通过精确协议选择 C 时，只消费 C，
  剩余队列保持 `[A, B]`。

  远程 Renderer 在写入请求前，必须使用其已认证的权威 machine-access 快照验证目标；快照
  不可用时应 fail closed。请求不得携带请求者身份：workspace Machine RPC 无法认证调用方
  声称的成员 ID，目标 daemon 也不得用它命中 owner fast path。同机 local IPC 已是可信的
  本地控制边界。

  Native 精确“引导”的 requester identity 必须来自已认证的活动 invocation，绝不来自共享
  queue row。若该冻结身份不可用，daemon 必须在消费 row、提交 provider 或停止 turn 之前失败。

  Native handoff 是持久 saga，而不是 CRDT 写入与 provider side effect 之间不存在的原子操作。
  machine-local、由 daemon 持有的 marker 记录 `reserved`、write-ahead `submitting`、provider `acknowledged`、本地已提交
  `applied` 或 `fallback`，且在结果持久化前保留所选 queue row。已进入 history 的 `reserved` 和
  `fallback` 可转为精确普通 turn；若 reservation 在写 history 前中断，则保留 row 在队列。
  `submitting` 结果不确定，`acknowledged` 可能已有 side effect，原 prompt owner 消失后两者都
  不得重放，而应落成可见失败。`applied` 证明本地 handoff 已完成，应恢复 accepted 回执，并由
  普通 crash handling 显示被中断的 turn。ACP 没有幂等提交键或交付查询，因此这里必须 fail closed。

  对 cancel-and-dispatch Steer，所选 queue row 是持久重试标记：先追加 history，再发布
  `latestUserMsgId`，且仅在两项写入都成功后删除 row。部分发布后的重试应复用已有 turn ID，
  不得重复追加 history。

- 过期或冲突的精确“引导”选择必须失败且无副作用。所选 ID 已不存在、编辑 lease 仍有效，或
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
- 编辑状态保留已有键盘与焦点行为，并在编辑结束前禁用该行重排。

## 边界与待审事项

只有“排队”和“引导”具有不同含义时，该快捷键才改变路由。空闲会话仍正常直接发送；没有
明确实时 prompt 活动时，即使反转意图是“引导”，也继续采用保守的排队屏障。触摸和鼠标共用
同一拖动区域；已安装应用和物理设备验证不由组件测试替代。Provider 未提供协议支持时无法
实现 exactly-once 恢复；结果不确定的 native 提交必须明确报错，绝不能静默重放。

## 实现证据

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/`
- `packages/components/tests/{session-message-submit-route,session-chat-input-submission,message-queue-row-editing}.test.*`
- `apps/cli/{tests/session-execution-service.test.ts,src/lib/loro/doc-user-turn.test.ts,src/session/session-queue-steer-operation-store.ts}`
- [决策记录](../.agents/notes/implemented/feature/2026-09-13-queue-steer-controls.zh.md)

这是供人工审阅的草稿；实现和测试通过不代表 Spec 已获批准。
