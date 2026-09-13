# 已完成回复下方不再显示「思考中」

Status: implemented
Translation: current

[English](./2026-09-11-thinking-under-finished-reply.md)

## 摘要

助手 turn 盖上 `finished` 后，桌面 footer 已经画出完成时间和耗时。turn 作用域释放前 session presence 仍是 `running`，活动条就会在这条已完成气泡下面继续写「思考中」。host 与 viewer 的 presence 和 history 不在同一平面交付，最后一条已完成气泡不能证明当前 turn 已经停止思考。执行端在 prompt / autoPrompt 共有出口上报可选的 `running.phase = finalizing`；UI 只根据该相位隐藏「思考中」。

## 决策

- 在 `{ type: 'running' }` 上增加可选 `phase: 'finalizing'`。不新增 `activity: 'finalizing'`，旧 `ActiveSessionStatusSchema` 会拒收该枚举并丢掉整条 presence。
- `markPromptWorkingEnded` 报告 `finalizing`，不清 presence。`markPromptWorkingStarted` 已会恢复 `thinking`，覆盖 autoPrompt 重启。
- Codex image begin/end 只改 presence activity（`thinking` ↔ `image_generation`），不写 durable `SessionMeta.status`，避免在途 `setStatus` 把 `finalizing` / idle 写回 running。
- UI 只在 live presence 为 `running` 且 `phase === 'finalizing'` 时藏活动条。不再按 last-history `finished` 藏灯。
- 保持 continueSession 原 thinking 顺序。更早的 `openAssistantEntry` 已在 initializing 之前发生；把 thinking 挪到内层 open 之后挡不住 viewer 历史落后。
- 旧端忽略未知 `phase` 并保留 `running`。没有 `phase` 的旧 host 仍会露出收尾残留的「思考中」。

## 证据与限制

Windows 0.93.3 真人确认完成后残留 Thinking 随后消失。独立复核复现了 goal resume：presence 已是 `running` 且 prompt 已在执行，viewer 历史仍停在上一条已完成 assistant。单元测试覆盖 presence-only 隐藏、旧 running 解析器保会话、history 落后的 goal resume、usage flush 收尾、autoPrompt start/end，以及 permission 仍为独立状态。未再跑打包 Electron 点击验证。
