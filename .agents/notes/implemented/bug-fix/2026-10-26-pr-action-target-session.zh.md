# PR 数据归属与动作执行目标分离

Status: implemented
Translation: current
Pull request: https://github.com/LodyAI/Lody/pull/1908

[English](2026-10-26-pr-action-target-session.md)

## 摘要

PR 视图曾将 GitHub workspace owner 的会话 ID 同时用于查询 PR 数据和查找实时冲突修复动作。打开子会话时，这会把提示发给根会话。现在 `PrTabContainer` 单独接收已有的已解析选择作为动作目标，同时保留 owner ID 用于 GitHub 查询和分析。容器测试验证子会话、根会话和无目标三种情况，会话外壳保留原有的内联选择逻辑。此前的浏览器截图使用合成会话 fixture，真实渲染生产 tab bar、会话消息流和 PR 冲突视图，显示对应结果。

## 决策

`SessionDetail` 继续以 `prSessionId` 表示 PR 数据 owner，并将现有的
`activeSessionTabId` 作为单独的 `actionSessionId` 传给两处 PR 视图。它是桌面和
移动共用的已解析选择结果：根会话和可见子会话保留各自 ID，未解析子会话、draft
和 empty 返回 `null`。不能使用 `activeTabSession?.id`：其展示回退会在子会话未解析
时故意返回根会话 metadata。`PrTabContainer` 只按执行目标读取冲突修复动作，因此
选择缺失时动作不可用。
选择逻辑继续内联在原有归属处；仅为向容器测试提供输入而提取 helper，不会增加产品行为。

## 证据与限制

现有 `session-chat-interface.tsx` 按自身 `session.id` 发布动作，而
`getSessionGitHubState` 将 `sourceSessionId` 解析为 workspace owner；子会话下两者
不同。`pr-tab-container.test.tsx` 向真实容器显式传入 child、root 或 null 动作目标，
检查派发落点、仍属于 root 的 PR 查询，以及无目标时不提供 root 动作；它不测试
会话外壳如何推导选择。移除 helper 后，7 项测试全部通过。临时恢复按 owner 查找
动作后，child 和 null 目标测试失败（2 项失败、5 项通过）。

本地验证使用 Node 26.12.1 和现有验证 checkout 中的 Vitest 3.2.4。其 lockfile
与本分支相同，但实际安装的 runner 与声明的 Vitest 5.0.2 不同，因此这不是完整的
锁定依赖验证。`pnpm check` 因缺少依赖停在无关的 `@lody/e2ee-core` 类型检查。
此前浏览器验收已显示 child 派发进入 child，pending/draft 不提供 root 动作；此次
清理不改变产品行为，PR #1908 中的截图继续保留。
