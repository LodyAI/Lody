# 保留 builtin Claude Bash 任务身份

Status: implemented
Translation: current

[English](2026-10-26-claude-task-actor-preservation.md)

## 摘要

builtin Claude 任务生命周期事件通过标准 ACP `session/update` 发送。终态事件缺少类型时，显示标题仍可使用回退值，但不能用它覆盖共享历史中此前报告的 `local_bash` actor。adapter 现在只省略缺失的 actor 字段，任务身份、合并行为和标题显示仍由现有模块负责。真实 adapter 到历史写入的测试和任务面板都确认完成后的任务仍显示为 Bash，并保留关联命令。

## 责任归属与决策

`packages/acp-extension-claude/src/acp-agent.ts` 中的 `createClaudeTaskLifecycleUpdate` 负责生成生命周期通知。未协商 async-task 事件的后台任务会进入 `emitTaskLifecycle`，再由 `sendUpdate` 发送标准 ACP 更新。`AgentClient.sessionUpdate` 将这些更新转交 CLI 历史；旧版 `_claude/taskLifecycle` handler 是另一条兼容输入路径，不会接收当前 builtin producer 的标准消息。

仅当 `subagent_type`、`workflow_name` 或 `task_type` 提供身份时，adapter 才写入 `_meta.lody.task.actor`。ACP tool-call 标题仍回退为 `Claude task`。因此共享历史按 task id 合并完成与迟到进度字段时，会保留更早的 `local_bash` actor 和 `toolUseId`；无需新增 task-type schema 或历史分支。

CLI 仍接收较旧 adapter 发出的 `_claude/taskLifecycle`，因此 converter 作为旧兼容路径保留并继续测试。共享 converter 的 `taskMetaFallbackActor` 可选项也继续保留：Kimi 测试验证既有 `Kimi task` 回退，显式事件类型仍会更新 actor。

## 验证与消融

CLI 历史测试现在会实例化真实 `ClaudeAcpAgent`，依次送入确定性的 Bash tool call、`task_started(local_bash)`、无类型完成事件和迟到进度，经由实际 `sessionUpdate` 回调进入历史处理，再把相同通知重放到新的历史文档。测试检查最终 actor、task id、关联 tool use、命令、状态和摘要。adapter owning suite 覆盖发出的标准 payload、标题回退和显式 workflow 类型。

- **红灯：** adapter 源码为 `269960a27ef6679813c569cc0c73bf501114a23a` 时，用例在真实完成 payload 处失败：期望不含 `actor`，实际得到 `Claude task`（1 失败、26 跳过；退出码 1）。
- **绿灯：** adapter 源码为 `cad4342265634ba3dcdc9f37e587a096596eaa67` 时，同一命令通过（1 通过、26 跳过；退出码 0）。`history.test.ts` 和 `claude-task-lifecycle.test.ts` 共 33 项通过，覆盖显式类型和 Kimi 兼容行为。
- `npm run check`、`npm run build` 和 adapter 的 `src/tests/acp-agent.test.ts` 套件通过（604 通过、10 跳过）。
- 使用 Node 26.12.1 的独立 clone 中，`pnpm format` 通过。完整 `pnpm check` 完成 typecheck、lint 和 effect lint 后，在 `test:ci` 报告 4,657 通过、4 跳过、1 失败。失败用例是 `src/session/git-identity.test.ts`：显式相对 Git 配置测试读到了主机身份 `wibus-wee`，而非测试身份 `Requester`。单独运行该用例可复现本机 Git 环境问题，与本修复无关。

去掉条件式 actor 省略会重现上面的红灯。将标题显示回退值留在 `title` 中可保留现有 ACP 表现；保留 Kimi 选项则满足 Kimi 兼容断言。没有新增抽象或状态。

## 可视化证据

baseline 和 fixed adapter 实际运行产生的历史记录被直接送入生产 `SubagentTaskPanel` 和详情对话框。两个 Story 都显示源码 SHA 和相同的确定性输入序列。基线显示 `Claude task` 且没有 Command 区；修复后显示 `Bash` 以及关联的 `printf synthetic-background-output` 命令。

| 基线（`269960a`） | 修复后（`cad4342`） |
| --- | --- |
| [面板](https://github.com/user-attachments/assets/6c073031-f649-4090-9fb5-1aae6147a34a) · [详情](https://github.com/user-attachments/assets/c9f0120e-811c-43d6-9cef-0aee89a6d4d6) | [面板](https://github.com/user-attachments/assets/40e8917a-b32b-436f-8e04-844b1471d594) · [详情](https://github.com/user-attachments/assets/a865040e-b419-425b-a70f-a58b12b113e5) |

adapter commit 已推送至 `LodyAI/acp-extension-claude` 的 `fix/omit-missing-task-actor` 分支；本 PR 通过 submodule gitlink 固定该 commit。本 issue 仍只有原 PR #1906，且保持 draft。

PR：https://github.com/LodyAI/Lody/pull/1906
