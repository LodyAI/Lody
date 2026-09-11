# 已完成回复下方不再显示「思考中」

Status: implemented
Translation: current

[English](./2026-09-11-thinking-under-finished-reply.md)

## 摘要

助手 turn 盖上 `finished` 后，桌面 footer 已经画出完成时间和耗时。host 收尾期间 session presence 仍可能是 `running`，活动条就会在这条已完成气泡下面继续写「思考中」。现在最后一条 history 是已完成 assistant 时不再画这行。presence 生命周期不改。

## 决策

- 用最后一条气泡决定要不要画活动条，而不是看到 `finished` 就清 presence。
- 权限等待和初始化文案照旧。history 里已有下一条用户 turn 时，思考中会再出现。
- 不在 `history.finished` 时清 presence；presence 是 session 级，还要罩住新 turn、权限等待和 autoPrompt。

## 证据与限制

Windows 0.93.3 真人在 Codex 首次对话确认顺序：回复和完成时间先出现，底部多余的「思考中」随后自行消失。没有精确重叠秒数。单元测试覆盖最后一条已完成 / 仍打开 / 后面又有用户 turn。此处未再跑打包 Electron。
