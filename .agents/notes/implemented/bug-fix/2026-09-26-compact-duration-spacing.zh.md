# 让中文时长紧接文案

Status: implemented
Translation: current

[English](2026-09-26-compact-duration-spacing.md)

## 摘要

共享格式化器已经将中文紧凑时长拼成 `7分25秒`，但外层文案仍显示
`工作了 7分25秒`。现在选定的文案是 `工作了7分25秒`，整段时长文案不留空格。
中文模板改为紧接格式化结果；英文仍显示 `7m 25s`。

## 决策

中文 `sessions.workedFor` 与 `sessions.activityWithDuration` 模板删除
`{{duration}}` 前的空格。共享格式化器的中文 `time.unitSeparator` 继续为空串，
因此一、二、三个单位的时长内部都没有空格。英文模板与格式保持不变。

[先前分隔符决策](2026-09-25-duration-unit-separator.zh.md)继续解释共享格式化器的
单位组间距；本次决策调整外层文案。当前行为见
[紧凑时长 Spec](../../../../specs/compact-duration-spacing.zh.md)。

## 验证与范围

时长测试使用实际中文语言包覆盖一、二、三个单位的结果、两种完整状态文案，
并确认英文格式未变。倒计时标签通过另一函数格式化单个短单位，不在本次调整范围内。
