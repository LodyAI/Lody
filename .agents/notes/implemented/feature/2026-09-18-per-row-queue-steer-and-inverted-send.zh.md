# 任意队列行可 Steer，快捷键反转忙碌发送路由

Status: implemented
Translation: current

[English](2026-09-18-per-row-queue-steer-and-inverted-send.md)

## 摘要

两个过去需要绕行操作的引导（steer）入口现在变为直达：在输入框按
Cmd+Shift+Enter 会针对这一次发送反转配置的忙碌行为（queue 默认变为 steer，
guide 默认变为 queue）；在 agent 声明原生 acknowledged steer 时，队列中的
每一行——而不仅是队首——都提供 Steer。两者都复用了既有的 guide 路由和
按 item 的 steer 处理器；新增逻辑只有提交路由解析器里的 `invertBehavior`
输入和行级可见性 gate。被拒绝的 steer 仍会通过 CLI 的"已证实未送达"提升
降级为普通下一条 turn，所以反转发送不会丢消息。剩下的代价是：非队首
item 的 steer 一旦降级，会跑在队首之前——这符合"现在发这条"的意图，
但属于隐式插队，值得记录。

## 问题与决策

既有机制之前有两个缺口：

- **忙碌发送路由只有全局设置。** `queuedMessageBehavior` 决定所有忙碌发送走
  queue 还是 steer；保留 queue 默认的用户想 steer 单条消息只能改设置。
  解析器本来就有 `forceQueue`/`forceDirect` 覆盖，缺的只是一个按次的
  "反转"，让配置的行为先翻转再过同一组守卫。现在 Cmd+Shift+Enter 设置
  `invertBehavior`（单按 Shift 仍是换行；单按 Mod 仍未绑定）。steer 仍然
  要求有明确在线的 prompt 活动和一个已知的未完成 assistant turn，所以
  在无可 steer 目标时快捷键会降级为普通路由。
- **Steer 行操作此前仅限队首**（`isFirst &&`），尽管原生路径按
  `$cid`/`userTurnId` 提升、从不关心位置。这个 gate 存在是因为 fallback
  ——interrupt-and-send——只取消当前 turn 并让 CLI 提升队首：用在非队首行
  会派发错误的 item。现在行按能力分流（`shouldShowQueuedItemSteer`）：
  authoritative `acknowledgedSteer` 存在时每行都显示 Steer；否则只有
  队首显示，那里 fallback 语义才正确。

`handleSteerQueuedMessage` 里的防御 guard 保证：非队首 item 在没有原生
steer 时即使到达 handler 也不会执行。

## 备选方案

- 无原生 steer 时对非队首行：自动执行"移到队首 → 同步 → interrupt"
  （把今天的手动流程内化），或"移除 item + 追加 pending history + dispatch"
  （绕过队列）。暂时拒绝：两条路都为一个不存在的能力增加第二条数据路径；
  隐藏操作对 agent 能力是诚实的。若用户要求任意行的 interrupt-and-send
  再重议。
- 快捷键绑定"强制 steer"而非"反转默认"被拒绝：反转用一个键位覆盖两个
  方向，且与已经铺设的 `forceQueue` 先例一致。
- 非队首 Steer 显示为禁用而非隐藏被拒绝：队列本来就按 `showSteerAction`
  条件渲染，而禁用按钮只会引出"为什么不能点"却答不上来的问题。

## 限制与验证

- 被 adapter 拒绝的反转 steer（或非队首行 steer）——`unsupported`、
  `stale-turn`、配置不匹配——会被提升为普通 pending turn，跑在队首
  之前。这符合明确的"现在发这条"意图，但会静默超过先前排队的 item。
- 快捷键目前还没有可见入口（发送按钮 tooltip 或快捷键帮助可后续补上）；
  draft 会话忽略它，因为 draft 无法 steer。
- 验证方式为路由解析器与行级 gate 谓词的单元测试加类型检查；未实测
  真实 agent 的 steering。

## 证据

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/{queued-message-steer,message-queue-row,message-queue-display,AGENTS.md}`
- `packages/components/tests/{session-message-submit-route,queued-message-steer}.test.ts`
- 相关：[steer stop and recovery ownership](../bug-fix/2026-09-16-steer-stop-recovery-ownership.md)、
  [interrupt pending input exactly once](../bug-fix/2026-09-14-interrupt-pending-input-exactly-once.md)
