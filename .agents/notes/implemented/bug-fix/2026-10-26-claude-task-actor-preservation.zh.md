# 保留 Claude 任务的 actor 类型

Status: implemented
Translation: current

[English](2026-10-26-claude-task-actor-preservation.md)

## 摘要

Claude 任务终态事件可能在启动事件已识别 Bash 任务后省略类型。若把显示用的 `Claude task` 回退值写入 actor 元数据，后续历史合并就会用它替换 `local_bash`，导致完成后的行丢失 Bash 标签和关联命令。修复保留标题中的显示回退值，但在 provider 未提供身份时省略 actor 元数据。显式 subagent、workflow 和 task 类型仍会记录；后续事件省略身份时，现有 task-id 合并会保留较早的身份。

## 证据与决策

`convertClaudeTaskLifecycleNotification` 从每条 Claude 生命周期事件构造 ACP task 更新。历史层将 `_meta.lody.task` 物化为任务项，并按 `taskId` 合并，后续已定义字段优先。任务面板通过 `actor === 'local_bash'` 或 `taskType === 'local_bash'` 识别 Bash；因此回退 actor 会同时隐藏关联命令并改变标签。

修复只在 actor 缺失时省略任务元数据。标题仍使用既有的本地化显示回退值，显式 `subagent_type`、启动事件中的 `workflow_name` 或 `task_type` 仍会写入 actor 元数据。增加单独的 task-type 字段会要求修改 shared schema、解析和 UI 消费者，却不能改善这个场景：现有合并契约已能用省略字段表示“没有新身份”。

task id 与 ACP session 作用域不变。事件继续走现有的按投递顺序历史合并。终态状态单调性仍由 `mergeSubagentTaskPayload` 负责；本修复只让缺失的 actor 元数据在实时和重建历史合并中保留早先的值。

## 验证

回归测试将合成的 `local_bash` 启动事件和缺少类型的完成事件转换后送入历史写入器，并检查重建任务仍保留 Bash actor、完成状态和摘要。转换器测试检查显示回退标题仍存在、缺少 actor 元数据时会省略该字段，以及显式报告的 task 类型仍会保留。

本地无法运行测试：该 nested checkout 没有 `node_modules`，且找不到 `vitest`。仓库检查和完整格式化也因缺少工作区工具而停止；变更文件通过使用 `pnpm dlx` 调用锁定版本 Oxfmt 的检查。当前 Node 为 26.11.1，低于声明的 26.12.1 最低版本，机器上也没有其他满足要求的版本。由于缺少相同依赖，本地桌面构建在启动前停止，因此未能产生真实 UI 前后截图。`pnpm run docs check` 报告了指向缺失 ACP 子模块的既存损坏链接和缺失翻译；没有报告这次新增的双语 note。这里如实记录这些限制，不将它们视为验收通过。

PR：待创建
