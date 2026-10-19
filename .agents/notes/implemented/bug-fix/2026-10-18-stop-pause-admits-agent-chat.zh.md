# Stop 只暂停结果回传唤醒，不拦 Agent chat

Status: implemented
Translation: current

[English](2026-10-18-stop-pause-admits-agent-chat.md)

## 摘要

支持 Inbox 的 Stop 会把会话暂停，直到用户发来可信消息；暂停期间所有非用户输入都会被拒绝。因此编排会话通过 Agent chat 发来的消息会被静默扣住，直到用户恰好再发一句话才执行，看起来就像派发丢了。现在 Stop 只暂停 Operation 完成结果的自动回传唤醒；用户或其他会话 Agent chat 发来的新输入同级处理，照常接受并解除暂停。代价是 Agent 现在可以恢复用户停止过的会话；防止 Agent 循环的硬性屏障仍是对话树停止。

## 证据

事故的 daemon 日志：一个 Operation 目标于 2026-10-17 13:02:58 被停止（`Session stop requested`，轮次结果 `cancelled`）。次日 02:02:17 到 02:03:01 之间，两条 `lody_session_chat` 输入被分发了六次，每次都以 `execution.visible_turn … outcome=inbox-paused` 结束。02:04:49 用户发了一句"收到了吗"，解除暂停；两秒后积压的消息开始执行，执行顺序是准入顺序，不是发送顺序。

原因：`apps/cli/src/orchestration/inbox/rules.ts` 的 `inputAcceptance` 在 `kind === 'task' && paused` 时返回 `reject`。没有匹配用户回执的输入都是 `task`，包括所有 Agent chat；`sqlite.ts` 里只有 `human` 输入被接受时才清除 `paused`。

## 决策

- 准入不再看 `paused`。新的非自动输入都会被接受，除非 Stop 已把它作为 Stop 前排队的输入取消。两种输入被接受时都会清除 `paused`；暂停写入失败后在服务里留下的否决标记，也由任一种输入清除。
- Stop 前排队的输入仍保持取消：Stop 仍把它们记为已取消，需要重新发送。
- 来源回执仍只决定输入是否记为 `human`，Inbox 用它决定优先处理哪条用户输入；回执不再决定 Stop 之后能否执行。
- 操作者恢复使用同一个暂停标记，因此新的 Agent chat 现在也能恢复经过操作者恢复的会话；恢复流程仍然不会重放已退役的执行。

## 备选方案

- 接受 Agent chat 但保留暂停。否决：该轮委派出去的 Operation 永远无法唤醒会话，编排会以另一种方式坏掉。
- 保留原规则，只把 `paused` 状态告知发送方。负责人否决：Agent chat 是明确的指令，应与用户输入同级。

## 验证

- `apps/cli/src/orchestration/inbox/inbox.test.ts`：新的 `human` 输入和 `task` 输入都能解除暂停并携带已保存结果；Stop 前排队的输入（包括其他请求方的）仍被拒绝。
- `apps/cli/tests/session-execution-service.test.ts`：支持 Inbox 的 Stop 之后，一条 Agent chat 轮次经真实 prompt 边界执行并解除暂停；回执恢复测试改为期望 Stop 后没有匹配回执的输入以 `task` 身份执行。
- `operation-model.ts` 把新输入建模为单一的 `human` 事件，已符合新规则，没有轨迹需要改动。
- 未用两个真实会话做端到端验证。
