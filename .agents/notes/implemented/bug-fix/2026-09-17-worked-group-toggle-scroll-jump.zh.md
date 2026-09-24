# Worked-group 折叠不再移动读者位置

Status: implemented
Translation: current

[English](2026-09-17-worked-group-toggle-scroll-jump.md)

## 摘要

在 Chat Session 中阅读底部上方内容时，点击已完成轮次的 "Worked for …"
头会把视图意外地拽到会话末尾。两个机制叠加：展开会对该头执行程序化
滚动到行，而虚拟列表在列表末尾附近会把目标偏移钳制到最大滚动位置；
同时滚动跟随库在几何变化使视口落入其近底容忍范围时重新挂上跟随锁——
即使读者是刻意向上滚动离开的。现在折叠切换永不滚动，且观察者回调
不再能重新武装跟随锁：只有真实滚动事件可以。正在跟随末尾的读者在
切换后仍然钉在末尾。

## 根因

`SessionChatStreamView` 展开时会对展开的头部调度 `scrollRowToTop`。当该
头靠近列表末尾时，`scrollToIndex(align: 'start')` 被钳制到最大滚动偏移，
产生一次大幅向下的程序化滚动。`use-stick-to-bottom` 无法把它与用户滚动
区分：向下方向清除 `escapedFromLock`，落入约 70px 的近底容忍范围会重新
武装 `state.isAtBottom`，此后跟随路径在每次几何变化时都把视图钉到底部。

另一个独立机制：库自身的内容 ResizeObserver 在视口处于近底容忍范围内时，
对任何净收缩回调都会重新锁定 `state.isAtBottom`（`difference < 0 &&
isNearBottom`）。虚拟列表 spacer 抖动或折叠都可能产生这种收缩；一旦重新
上锁，库排队的 `scrollToBottom` 动画 tick 与本 hook 自己的 `follow()` 都会
写 `scrollTop`——仅在提交期内生效的抑制无法阻止这次滑动，而提交时刻的锁
快照又会被重新上锁引发的状态冲刷提交在挂起回调运行前覆盖。

## 契约

- 切换 worked group 或 activity group 永不滚动。头停留在读者点击的像素
  位置，行在其下方展开或收起。
- 跟随锁（`state.isAtBottom`）只能由滚动事件与显式 `scrollToBottom` 武装；
  观察者回调绝不能重新武装它。hook 每次提交快照该锁（`wasFollowingRef`，
  程序化跳转抑制期间强制为 false），并以此门控 `follow()` 滚动。其内容
  ResizeObserver 回调在同一批次内运行于库的回调之后，当快照显示未跟随时
  会释放同批次的重新上锁，使排队的动画 tick 发现锁已打开。
- `scrollRowToTop` 仍是唯一的行索引到滚动换算，现仅用于大纲跳转、搜索与
  命令式滚动。

## 证据与验证

复现保留为 Storybook 场景
`Sessions/ConversationView → WorkedGroupExpandJump`（确定性合成历史，
无抓取的真实转录）。agent-browser 驱动真实点击的测量结果：

- 距底约 400px：展开与收起后 `scrollTop` 完全不变。
- 距底约 50px（库的近底容忍范围内）：同样不变。
- 正在底部：视图保持在底部——跟随意图被保留。
- 3000 轮虚拟列表：可见头在展开与收起中保持同一视口偏移。

`tests/sticky-scroll-virtua.test.tsx` 以真实 `Virtualizer` 挂载该 hook 并
注入模拟观察者：折叠提交的收缩回调无法为已脱离的读者重新上锁（无滚动
写入、位置保持），而跟随中的读者仍落在库的一像素容差内的末尾。

## 取舍与限制

点击已挂载但完全位于视口上方的行（Virtua 渲染缓冲）仍会触发 Virtua 的
条目尺寸滚动补偿并在最大偏移处被钳制——这是针对插入到滚动位置上方内容
的正当锚定，且可见行无法通过指针触达此路径。仍存在一个窄竞态：若某次
resize 回调恰好落在用户滚到底部的重新上锁与其提交之间，该意图会被释放；
读者再滚动一次即可重新上锁。按 `packages/components/src/hooks/AGENTS.md`
的滚动不变量，未引入任何定时器或逐帧重试。
