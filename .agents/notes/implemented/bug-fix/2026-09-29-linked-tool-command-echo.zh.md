# 在工具详情中去除带链接的重复命令

Status: implemented
Translation: current

[English](2026-09-29-linked-tool-command-echo.md)

## 摘要

ACP 工具调用可能同时包含结构化 shell 命令，以及把文件路径写成 Markdown 链接的命令文本副本。
文本渲染后与命令相同，但直接比较原始字符串会漏掉链接语法，导致命令显示两遍。工具详情现在
以链接的可见标签比较结构化命令，只移除整段重复命令，保留结果文本。此改动仅影响展示，
不改变历史存储或终端输出的传递。

## 决策与边界

[工具步骤详情](../feature/2026-09-26-tool-step-detail-sheet.zh.md)已经会移除完全一致的命令副本。
`tool-call-command.ts` 现在先展开候选文本中的简单 Markdown 链接，再做空白和 worktree 路径
归一化比较。候选文本仍须整体等于某条结构化命令；附有额外说明或不同命令的文本继续显示。

## 验证与限制

`tool-call-command.test.ts` 覆盖带链接的命令副本和不同文本；
`agent-activity-row.test.tsx` 验证展开后命令只显示一次，输出仍在。合成的
`Sessions/ToolCallSteps.CustomAcpEcho` Story 使用相同浏览器尺寸，通过 Playwright 拍摄
修复前后画面。原始 provider 的 ACP 通知不可用，因此这个 Story 验证的是重复展示形态，
并未证明 provider 实际发送的每个字节。
