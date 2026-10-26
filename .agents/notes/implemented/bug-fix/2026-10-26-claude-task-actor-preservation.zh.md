# 保留 Claude 任务的 actor 类型

Status: implemented
Translation: current

[English](2026-10-26-claude-task-actor-preservation.md)

## 摘要

Claude 任务终态事件可能在启动事件已识别 Bash 任务后省略类型。若把显示用的 `Claude task` 回退值写入 actor 元数据，后续历史合并就会用它替换 `local_bash`，导致完成后的行丢失 Bash 标签和关联命令。修复保留标题中的显示回退值，但在 provider 未提供身份时省略 actor 元数据。显式 subagent、workflow 和 task 类型仍会记录；后续事件省略身份时，现有 task-id 合并会保留较早的身份。

## 证据与决策

`convertClaudeTaskLifecycleNotification` 从每条 Claude 生命周期事件构造 ACP task 更新。历史层将 `_meta.lody.task` 物化为任务项，并按 `taskId` 合并，后续已定义字段优先。任务面板通过 `actor === 'local_bash'` 或 `taskType === 'local_bash'` 识别 Bash；因此回退 actor 会同时隐藏关联命令并改变标签。

修复将标题显示回退值与可选的任务元数据回退值分开。Claude 不设置后者，因此缺少类型的事件会让 actor 保持未定义，并由现有合并逻辑保留早先身份。显式 `subagent_type`、启动事件中的 `workflow_name` 或 `task_type` 仍会写入 actor 元数据。共享转换器也服务于 Kimi；通过显式选项保留其既有的 `Kimi task` actor 回退值。全局删除该回退时 Kimi 测试失败，证实该显示契约仍然有效。增加单独的 task-type 字段则要修改 shared schema、解析和 UI 消费者，却不能改善这个场景。

task id 与 ACP session 作用域不变。事件继续走现有的按投递顺序历史合并。终态状态单调性仍由 `mergeSubagentTaskPayload` 负责；本修复只让缺失的 actor 元数据在实时和重建历史合并中保留早先的值。

## 验证

拥有该行为边界的测试依次转换 `task_started(task_type=local_bash)`、缺少类型的完成 `task_notification` 和迟到的无类型 `task_progress`，通过历史写入器应用事件，再确认重建结果只有一个 task id，且保留 Bash actor、完成状态和摘要。在独立 clone 的源码提交 `779edf736b072965dcfb92618352e050a02620b5` 中，临时恢复 Claude 缺失类型时写入元数据回退的行为后，此用例失败：期望 `actor: local_bash`，实际得到 `actor: Claude task`（1 项失败，26 项跳过）。恢复已提交转换器后，同样的 owning suites 通过：`history.test.ts` 与 `claude-task-lifecycle.test.ts` 共 33 项通过。两套测试也验证了显式 task 类型更新和 Kimi 回退不变。本次跟进未新增回归测试。

Storybook 使用合成会话历史投影渲染现有 `SubagentTaskPanel`，输入序列与上面相同。真实面板基线显示 `Claude task` 且没有 Command 区；修复后显示 `Bash` 和关联的合成命令。截图均标注源码 SHA 和输入：[基线面板](https://github.com/user-attachments/assets/b5b3dd76-9619-4ee2-bb6e-5db0993ec563)、[基线详情](https://github.com/user-attachments/assets/333e5b35-53aa-4f54-8604-dd882494a8a7)、[修复后面板](https://github.com/user-attachments/assets/c0e930ff-179a-4c66-9e84-dc138ae1c001)、[修复后详情](https://github.com/user-attachments/assets/a72f27f5-95c6-4ce8-8f30-3ded400e95bb)。临时 story 和回退修改仅在 `/tmp/lody-1809-verify`，未进入 PR。

验证在 Node 26.12.1 和独立 clone 的 frozen root install 下进行。该环境中的 `pnpm format` 通过。完整 `pnpm check` 在 `prepare:acp-adapters` 停止，因为锁定的 Claude ACP 子模块没有安装 package-local TypeScript 依赖；root workspace 将该子模块作为独立依赖排除。变更行为由本地通过的 owning suites 和最新远端 CLI、Static checks 覆盖：[CLI job](https://github.com/LodyAI/Lody/actions/runs/40297222519/job/121486103742)、[Static job](https://github.com/LodyAI/Lody/actions/runs/40297222519/job/121486103559)。同一 PR HEAD 的远端桌面 smoke、浏览器测试、其余测试分片和贡献策略检查也均通过。`pnpm run docs check` 仍报告缺失 ACP 子模块链接和未翻译文档等既有问题，没有报告这两份更新的 note。

PR：https://github.com/LodyAI/Lody/pull/1906
