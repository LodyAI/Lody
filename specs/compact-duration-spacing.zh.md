# 紧凑时长的空格

Status: draft
Translation: current

[English](compact-duration-spacing.md)

紧凑时长按产品语言格式化。中文的数字与单位、相邻单位组之间均不留空格，
显示为 `7分25秒`；英文维持 `7m 25s`。中文外层文案也直接连接时长，因此
运行状态显示为 `工作中（工作了7分25秒）`。

运行中和已结束的回合、目标指标、CI 运行时长及子代理任务时长使用同一种时长格式。
倒计时标签使用独立的短标签格式。

## 依据

- 实现：[时长格式化器](../packages/components/src/lib/format-duration.ts)和
  [中文语言包](../locales/zh_CN.json)。
- 验证：[时长测试](../packages/components/tests/session-history-duration.test.ts)。
- 决策：[空格调整记录](../.agents/notes/implemented/bug-fix/2026-09-26-compact-duration-spacing.zh.md)。
