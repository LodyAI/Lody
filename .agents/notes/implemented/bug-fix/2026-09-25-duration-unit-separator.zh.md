# 时长单位分隔符本地化

Status: implemented
Translation: current

[English](2026-09-25-duration-unit-separator.md)

## 摘要

`formatDurationCompact` 用硬编码 ASCII 空格拼接各时间单位，导致 zh-CN 时长渲染
为 "43分 32秒"——"分" 和 "秒" 之间的空格在中文排版里显得松散且不地道。现在拼接
符来自本地化的 `time.unitSeparator`：英文为 " "，中文为 ""。`lib/format-duration.ts`
新增统一的 `getDurationUnitLabels(t)` 构造器，输出单位加分隔符，任何调用方都无法再
漏掉这个分隔符。zh 现在渲染为 "工作了 43分32秒"；英文输出不变。

## 问题与证据

运行中 turn 的活动行（`view.tsx` 的 live group label，经 `LiveActivityLabel` /
`sessions.activityWithDuration`）显示 "调用了 1 个命令（工作了 2分 01秒）"。让时长
读起来像两截松散片段的正是 "2分 01秒" 里的空格。同一拼接逻辑还喂给所有时长界面：
worked-group header、turn footer、goal banner 指标、PR CI 运行时长、subagent 任务行——
每处都各自内联构造同样的三字段 `DurationUnitLabels`。

## 方案

- `DurationUnitLabels` 增加可选 `separator`（默认 `' '`），在
  `formatDurationCompact` 内部用于连接 h/m/s 各段。
- 新增 `getDurationUnitLabels(t)` 助手，返回三个单位外加
  `separator: t('time.unitSeparator', ' ')`；原先七处内联构造全部改用它，
  防止漏传分隔符。
- 语言包：`en` 为 `" "`（输出不变），`zh_CN` 为 `""`。i18next 的
  `returnEmptyString` 默认值会原样返回空串，`lint:i18n` 的键存在性检查两侧均通过。

考虑过的替代方案：在单位串内检测 CJK 字符（属于隐藏启发式，且排版规则不该藏在
单位文案里）；或按段数分别做 i18n 模板（语序控制更完整，但三个键加更多插值，在
现有两个语言下没有实际收益）。

## 局限

分隔符只覆盖 h/m/s 拼接；外层模板（如 "工作了 {{duration}}"）保留自己的
汉字—数字间距。`session-info-chips.tsx` 的单单位标签不涉及拼接，不受影响。
验证方式：对 formatter 做 Node strip-types 冒烟运行（en 输出 "43m 32s"，zh 输出
"43分32秒"，缺省 separator 回退 " "）并跑了 `lint:i18n`；本嵌套 worktree 未安装
node_modules，未运行完整 `pnpm check`。
