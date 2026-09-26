# 紧凑时长的空格

Status: draft
Translation: current

[English](compact-duration-spacing.md)

用户在界面中阅读紧凑时长时，数字与单位之间、相邻的单位组之间按产品语言留空格。
中文显示为 `7 分 25 秒`，英文显示为 `7m 25s`。外层句子自行决定它与时长之间
的间距，因此中文运行状态显示为 `工作中（工作了 7 分 25 秒）`。

运行中和已结束的回合、目标指标、CI 运行时长及子代理任务时长使用同一种时长格式。
倒计时标签使用独立的短标签格式。

## 依据

- 实现：[时长格式化器](../packages/components/src/lib/format-duration.ts)和
  [中文语言包](../locales/zh_CN.json)。
- 验证：[时长测试](../packages/components/tests/session-history-duration.test.ts)。
- 决策：[空格调整记录](../.agents/notes/implemented/bug-fix/2026-09-26-compact-duration-spacing.zh.md)。
