---
Status: implemented
Translation: current
Language: zh
Counterpart: 2026-10-26-pr-action-target-session.md
---

# PR 数据归属与动作执行目标分离

## 摘要

PR 视图曾将 GitHub workspace owner 的会话 ID 同时用于查询 PR 数据和查找实时冲突修复动作。打开子会话时，这会把提示发给根会话。现在 `PrTabContainer` 单独接收当前选中会话作为动作目标，同时保留 owner ID 用于 GitHub 查询和分析；目标缺失时禁用动作。组件测试覆盖根会话、子会话和无目标三种情况，但当前 checkout 缺少依赖，运行验证仍待完成。

## 决策

`SessionDetail` 继续以 `prSessionId` 表示 PR 数据 owner，并将
`activeTabSession?.id ?? null` 作为单独的 `actionSessionId` 传给两处 PR
视图。`PrTabContainer` 只按该动作目标读取冲突修复动作。这样既保留
GitHub 查询归属，也让缺失的执行目标安全地保持不可用，不回退到根会话。

## 证据与限制

现有 `session-chat-interface.tsx` 按自身的 `session.id` 发布动作，而
`getSessionGitHubState` 将 `sourceSessionId` 解析为 workspace owner；子会话
下两者不同。现有 `pr-tab-container.test.tsx` 已加入对所选动作目标和保留的
查询 owner 的渲染行为断言。复用 lockfile 完全一致的预装依赖后，该套件
7 个测试全部通过。临时恢复按 owner 查动作后，子会话目标和无目标用例失败，
根会话目标用例仍通过。无法提供完整 UI 截图：Storybook 预览因 ACP 扩展
子模块缺失而无法解析；冲突动作的目标只会在提示追加到会话后显示，而现有
PR 单视图故事不渲染会话内容。
