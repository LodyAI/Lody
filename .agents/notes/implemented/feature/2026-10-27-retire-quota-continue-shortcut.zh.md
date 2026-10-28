# 退休 Claude quota-continue 快捷方式

日期：2026-10-27
状态：implemented
翻译：current

[English](2026-10-27-retire-quota-continue-shortcut.md)

## 摘要

#1935 的 composer 快捷方式允许用户在 Claude 五小时额度重置时预约一条字面量
`continue`。现在会话自动化有了 `recoverCapacity`：结构化额度失败后，在同一个
会话里继续。两条路径都盯着同一个重置点，可能产生两次继续。移除 composer 快捷
方式及其调度 helper；已有的持久预约仍然是普通定时消息，可以查看和取消。
`recoverCapacity` 成为自动额度继续的唯一所有者。

## 决定

- 从 composer 移除 `QuotaContinueAction`，删除它的调度 helper、测试和 Storybook
  stories。
- 保留定时消息能力和所有已存预约。不删除、不迁移任何 schedule。
- `recoverCapacity` 拥有自动额度继续。它是 per-session、默认关闭，并继续由 Host
  做能力门控。
- [旧的 Claude 快捷方式笔记](../../proposed/feature/2026-10-27-quota-continue.md)
  保留为历史；这篇笔记取代它的 UI 入口。后端策略仍由
  [continuation coordinator 笔记](../../proposed/architecture/2026-10-25-session-automation-coordinator.md)拥有。

## 证据与限制

- 旧挂载点在 `session-chat-input-area.tsx`；helper 会为已存在的会话创建一条
  reset + 1 秒的 `continue` 草稿。
- 新策略响应 `provider.quota.exhausted`，保留 pending work 并继续同一个会话。
  Claude 和 Codex 订阅账号已验证；其他 Provider 仍然走能力门控。
- 新 UI 还没接 renderer。接上之前，composer 不提供额度继续。这是有意的缺口，
  不是静默回退。
- 已有的定时 continue 仍由定时消息所有者执行；它们不会被转换成 automation。
