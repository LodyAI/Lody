# 统一中文紧凑时长的空格

Status: implemented
Translation: current

[English](2026-09-26-compact-duration-spacing.md)

## 摘要

上次时长调整将中文单位拼成 `7分25秒`，而现在明确要求界面显示
`工作了 7 分 25 秒`。紧凑时长现在分别本地化数字与单位、相邻单位组之间的空格。
英文仍显示 `7m 25s`；倒计时标签继续使用独立的短标签格式。

## 决策

共享格式化器读取新的 `time.numberUnitSeparator` 和已有的
`time.unitSeparator`。中文两者都是空格；英文的数字与单位之间没有空格，单位组
之间有空格。外层 `sessions.workedFor` 与 `sessions.activityWithDuration`
模板已经提供时长前的一个空格。

这次调整替换了[先前分隔符决策](2026-09-25-duration-unit-separator.zh.md)中的
中文间距选择；旧记录保留共享格式化器为何统一负责这些界面的历史依据。当前行为
见[紧凑时长 Spec](../../../../specs/compact-duration-spacing.zh.md)。

## 验证与范围

时长测试使用实际中文语言包覆盖一、二、三个单位的结果、完整的 `工作了` 文案，
并确认英文格式未变。倒计时标签通过另一函数格式化单个短单位，不在本次调整范围内。
