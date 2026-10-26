# PR 数据归属与动作执行目标分离

Status: implemented
Translation: current
Pull request: https://github.com/LodyAI/Lody/pull/1908

[English](2026-10-26-pr-action-target-session.md)

## 摘要

PR 视图曾将 GitHub workspace owner 的会话 ID 同时用于查询 PR 数据和查找实时冲突修复动作。打开子会话时，这会把提示发给根会话。现在 `PrTabContainer` 单独接收已解析的会话选择作为动作目标，同时保留 owner ID 用于 GitHub 查询和分析。测试覆盖根会话、已解析子会话、pending 子会话、draft 和 empty；消融后，三种无目标情况都会错误提供根会话动作。浏览器截图使用合成会话 fixture，真实渲染生产 tab bar、会话消息流和 PR 冲突视图，显示基线错派与修复后的子会话及无目标结果。

## 决策

`SessionDetail` 继续以 `prSessionId` 表示 PR 数据 owner，并将现有的
`activeSessionTabId` 作为单独的 `actionSessionId` 传给两处 PR 视图。它是桌面和
移动共用的已解析选择结果：根会话和可见子会话保留各自 ID，未解析子会话、draft
和 empty 返回 `null`。不能使用 `activeTabSession?.id`：其展示回退会在子会话未解析
时故意返回根会话 metadata。`PrTabContainer` 只按执行目标读取冲突修复动作，因此
选择缺失时动作不可用。

## 证据与限制

现有 `session-chat-interface.tsx` 按自身 `session.id` 发布动作，而
`getSessionGitHubState` 将 `sourceSessionId` 解析为 workspace owner；子会话下两者
不同。`pr-tab-container.test.tsx` 将 `SessionDetail` 使用的同一选中会话解析器接入
冲突按钮，并检查提示实际落点，覆盖根会话、已解析 child（PR 查询仍属于 root）、
pending child、draft 和 empty。使用 Node 26.12.1 和 lockfile 相同的依赖树，9 项
测试通过。消融“无目标不回退”逻辑后，pending/draft/empty 都错误提供 root 动作
（3 项失败、6 项通过）。浏览器验收使用合成会话 fixture，并真实渲染生产
`SessionTabBar`、会话页/消息流与 PR 冲突视图：基线点击 pending child 后提示落在
root；修复后 child 提示落在 child，pending/draft 不显示修复动作也不向 root 写入。
截图已附在 PR #1908。
