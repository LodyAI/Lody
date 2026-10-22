# 拒绝执行后保留 Claude 计划展示

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1824

[English](2026-10-22-claude-rejected-plan-display.md)

## 摘要

Claude 审批时把计划同时放在工具正文和 `rawInput.plan` 中。拒绝执行后，工具正文被拒绝提示替换，而 Lody 的解析器优先读取正文，误将提示当作计划。在仓库场景样本中，原计划仍保存在原始输入里。解析器现在优先读取明确的计划输入，对仅提供正文的适配器保留正文回退。已有历史卡片无需数据迁移或适配器运行时更新即可恢复展示。

## 证据与范围

- Claude 的 `ExitPlanModeReporter.errorResult` 只对 AIR 客户端抑制展示输出。Lody 没有声明 AIR 能力，通用错误渲染会发送替换正文。
- 共享 `mergeToolCallMessage` 按 ACP 语义替换正文，结果未提供原始输入时则保留旧值。修改通用合并语义会影响其他工具结果。
- 修复前，`resolvePlanExitMarkdown` 先读取第一个正文文本，再读取 `rawInput.plan`，所以拒绝提示遮住了仍被保留的计划。
- Claude 仓库的合成场景 `src/tests/acp-scenarios/__snapshots__/v2/exit-plan-reject.jsonl` 包含这一序列。使用真实 UI 解析器运行 Node 断言，确认初始计划解析正常，结果到达后原始输入仍保留计划，但解析器返回拒绝提示。

## 实现与验证

共享计划解析器先读取非空字符串 `rawInput.plan`，再读取工具正文。仅正文计划仍取第一个非空文本块，非法或空白原始计划不会阻止回退。Codex 的独立计划行仍负责展示。无需修改通用历史合并或适配器。仅修复适配器需要发布运行时，且无法恢复已存储的旧卡片。

已有 plan-surface 套件覆盖拒绝或批准后正文替换、历史 JSON 加载、空替换正文、非法原始计划、Kimi 尾随动作说明，以及独立计划和待决状态辅助函数。两个替换场景在修复前失败，修复后全部 19 个测试通过。已有的拒绝计划 Storybook 样本也改为模拟 Claude 的失败状态、保留的计划输入和替换后的错误正文。

当前检出未安装工作区依赖，测试使用 Vitest 3.2.4 和临时 Node 专用配置。完整包类型检查及 UI/Storybook 执行尚未验证；宿主 Node 22.20.0 低于仓库要求。文档检查报告既有的未初始化子模块链接错误，新增双语笔记无错误。本次未读取真实用户会话。
