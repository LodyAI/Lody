# 回到最新按钮显示工作状态

Status: implemented
Translation: current

[English](2026-09-27-scroll-to-latest-working-state.md)

## 摘要

用户向上阅读时，如果 Agent 仍在输出，对话底部的“回到最新”按钮此前始终显示普通向下箭头，
无法表达还有新内容正在到达。现在会话流复用已有的工作中信号：输出进行时显示共享的旋转图标，
等待授权时保留箭头。组件测试和两个 Storybook 交互 story 覆盖了这两种状态；浏览器执行已确认图标正确。

## 决定

- `SessionChatStreamView` 负责这个按钮，并复用驱动活动提示的 `agentActivityShimmer` 信号切换图标。
- 非空活动标签且 `agentActivityShimmer` 为真时视为工作中。等待授权使用不闪烁的警告状态，因此继续显示普通导航箭头。
- 不新增第二个 presence 订阅或额外状态属性；活动提示和按钮继续使用同一份权威状态。

## 证据与限制

- 原实现会在 `packages/components/src/components/ai-gui/view.tsx` 无条件渲染 `ArrowDown`；现在工作中渲染
  `Spinner`，警告或空闲状态保留向下箭头。
- `packages/components/tests/agent-activity-row.test.tsx` 用合成的向上滚轮解除吸底，然后分别断言工作图标和授权等待箭头。
- 用户可见行为已写入[对话滚动 Spec](../../../../specs/conversation-scroll.md)。

## 验证

`git diff --check`、Oxfmt、components typecheck 和定向 Oxlint 均通过。
`tests/agent-activity-row.test.tsx` 的 14 个测试全部通过。Storybook production build 成功，
无头浏览器检查两个新增 story 分别观察到工作中旋转图标和等待授权向下箭头。
`pnpm run docs check` 仍被仓库已有的、指向未初始化 ACP 子模块的断链阻塞。

- Pull request: [#1073](https://github.com/LodyAI/Lody/pull/1073)。
