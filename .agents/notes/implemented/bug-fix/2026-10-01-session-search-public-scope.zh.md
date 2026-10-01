# 统一公开会话搜索说明

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1187

[English](2026-10-01-session-search-public-scope.md)

## 摘要

公开简介承诺搜索工具调用、终端输出和 diff，但当前索引与详细指南明确只支持对话正文。
简介现已与该范围一致，中英文指南也区分了正文搜索与命令面板中的会话导航搜索。
回归测试验证了正文中的路径、代码仍可搜索，同时相同的工具载荷不会增加命中。
搜索行为与索引范围均未改变。

## 纠正与证据

在 main `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04` 上，
[提取器](../../../../packages/components/src/lib/session-chat-search.ts)
只接受 `text`、`thought`、`proposed_plan`。
[增量读取路径](../../../../packages/components/src/hooks/use-incremental-search-blocks.ts)
使用同一提取器。工具载荷、结构化计划清单、目标和 worktree 脚本输出是有意排除的；
问题属于简介文案过时，而非尚未实现的要求。扩展索引会改变既有的噪声过滤决策，
不在本次纠正范围内。Spec 意图没有变化。

[详细指南](../../../../site-docs/content/docs/zh/%28features%29/session-search.mdx)
负责说明范围与排除项。消息或提案计划正文里的路径、代码可以搜索；排除工具中的
文件路径字段，并不意味着排除正文里的路径文字。
[命令面板](../../../../packages/components/src/components/commands/command-palette.tsx)
则匹配会话标题、项目或仓库名称、分支名。
[侧边栏搜索决策](../feature/2026-09-11-sidebar-search.zh.md)保持不变。
PR [#1063](https://github.com/LodyAI/Lody/pull/1063) 修复高亮的 DOM 所有权问题，
没有解决公开说明的范围冲突；其[记录](2026-09-27-search-marks-keep-react-text.md)仍然有效。

## 验证与边界

既有[搜索测试集](../../../../packages/components/tests/session-chat-search.test.ts)
通过 Vitest 3.2.4 和临时 Node 配置运行，六项测试全部通过。新增的混合历史回归
检查两条提取入口、结果标识、命中偏移，以及只存在于工具载荷中的标记零命中。
原有工具排除测试也补充了 JSON 入参覆盖。无需修改生产代码。

worktree 未安装依赖。`pnpm check` 停在缺少 `tsgo`，`pnpm format` 停在缺少
`oxfmt`。仓库 docs status 在修改前已报告 62 个指向缺失 ACP 子模块文件的断链，
没有已注册的 SHA 保护主题；`pnpm run docs check` 仍报告这些既有错误。
Oxfmt 0.65.0 对全部八个改动文件的格式检查与 `git diff --check` 均通过。
聚焦回归没有验证完整应用的类型与构建检查、部署后的
文档，也没有重新验证生产 UI 交互。
