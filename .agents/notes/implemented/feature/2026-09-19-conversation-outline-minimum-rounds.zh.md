# 对话大纲栏在满十个用户轮次后才出现

Status: implemented
Translation: current

[English](2026-09-19-conversation-outline-minimum-rounds.md)

## 摘要

对话大纲栏——左侧每轮一格的总览目录——此前在桌面端只要有两轮以上就
挂载，短会话里那几根刻度只是装饰而非导航。现在改为当对话的用户轮次达到
`OUTLINE_MIN_USER_ROUNDS`（10）时才挂载。阈值判定放在
`SessionChatStreamView` 的挂载处而非 `ConversationOutlineRail` 组件内部，
因此组件本身仍可独立使用（stories、预览），仅保留 `< 2` 的退化兜底。

## 决策

阈值通过 `lib/conversation-outline.ts` 的 `countUserDrivenRounds` 统计
用户发起的轮次：agent 发起的首个 round（定时任务或 fork，标记为
`startsWithAgent`）不算用户驱动的轮次，不计入。此类条目至多一条，因此
这一区分只影响 agent 发起的会话。

在视图层而非组件层做门槛，保持了 rail 的纯展示属性——其自身的 `< 2`
提前返回仍是退化场景兜底，条目较少的 Storybook 故事也照常渲染。不挂载
还意味着 rail 的副作用（到达意图指针监听、ResizeObserver）在短会话中
根本不会安装。大纲条目与锚点仍照常计算，使 rail 首次出现时 active-index
状态已经就绪。

## 验证

`packages/components/tests/conversation-outline.test.ts` 覆盖了
`countUserDrivenRounds`：常规计数、边界处对首个 agent round 的排除、以及
空大纲。`ShortStreamHidesRail` story 记录了真实 `SessionChatStreamView`
中的隐藏状态（四轮不挂载 rail），十四轮的 `InsideTheConversationStream`
仍正常显示。
