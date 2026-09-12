# 已完成回复下方不再显示「思考中」

Status: implemented
Translation: current

[English](./2026-09-11-thinking-under-finished-reply.md)

## 摘要

助手 turn 盖上 `finished` 后，桌面 footer 已经画出完成时间和耗时。host 收尾期间 session presence 仍可能是 `running`，活动条就会在这条已完成气泡下面继续写「思考中」。最后一条是已完成 assistant 且 presence 为残留 `running` 时不再画「思考中」。Goal resume 没有 user 行；`thinking` 相位改到 `openAssistantEntry` 之后，空窗停在 `initializing`，presence 文案仍显示。

## 决策

- 同一 turn 收尾：last finished + presence `running` 时藏 Thinking。
- `initializing` / `requestPermission` 不藏。Goal 在 assistant 条目出现前保持 initializing。
- continueSession 在 `openAssistantEntry` 之后才发 `thinking` presence。
- 不在 `history.finished` 时清 presence。

## 证据与限制

Windows 0.93.3 真人确认完成后残留 Thinking 随后消失。单元测试覆盖 last finished / 打开 / 后续 user turn、initializing 不藏、continueSession thinking 在 assistant entry 之后。未再跑打包 Electron，也未做 Goal 按钮真人点击。
