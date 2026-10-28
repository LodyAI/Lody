# 子代理与任务分栏

Status: implemented
Translation: current

[English](2026-10-28-subagent-task-tabs.md)

## 摘要

一轮对话的任务面板把 agent 运行和后台 shell 命令放在同一个列表里，读者无法分辨哪些行是 agent。现在当一轮同时包含两类时，面板分成“子代理”和“任务”两个 Tab，默认选中“子代理”；每个 Tab 在有任务运行时显示加载图标和运行数量。只有一类时仍是单一列表。分类在渲染层依据 provider 的任务类型推断，因为发布出来的 `taskKind` 并不区分 agent 与命令。

## 分类

`taskKind` 不标记 agent 还是命令：Claude 生命周期适配器
（`apps/cli/src/agent/claude-task-lifecycle.ts`）对任何进入后台的运行（包括后台
agent）都发布 `background`，其余一律发布 `subagent`（包括前台 shell 任务）。因此
`subagent-task-state.tsx` 中的 `groupOf` 在以下情况把任务归入“任务”：`taskKind`
为 `scheduled`，或 `taskType`（来自 Core 元数据时为 `actor`）是 `local_bash`、
`mcp_task` 或 `monitor_mcp`。带有 `subagentType` 或规范化 `run` 的任务始终是子代理。
无法识别的类型留在“子代理”，与拆分前所有行都在同一列表的位置一致。

每个任务按自身类型归类。子代理启动的命令在“任务”中作为顶层行显示，而不是缩进在
父任务下；若让它跟随父任务留下，“任务”Tab 就不完整了。

## 行为

- 头部摘要、等待计数以及“有运行中任务时保持展开”的规则不变，仍统计全部任务。
- 选中的 Tab 是组件状态，任务更新时保持不变，只在面板重新挂载时重置。
- 未激活的 Tab 面板会卸载；对话框仍按任务 id 定位，不受影响。

## 证据与局限

`tests/subagent-task-panel.test.tsx` 覆盖：单一类型时的列表、后台 agent 被归为子代理、
默认 Tab、运行标记和计数，以及任务变化时已选 Tab 保持不变。组件类型检查通过。
`SubagentsAndCommands` story 展示混合状态。类型清单基于当前 Claude Agent SDK 的任务类型；
新的非 agent 类型在加入清单前会显示在“子代理”中。
