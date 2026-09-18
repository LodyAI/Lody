# 会话首次显示不是跟随锁

Status: implemented
Translation: current

[English](2026-09-18-conversation-initial-reveal-follow-lock.md)

## 摘要

打开 Chat Session 时，消息 DOM 已经齐全，对话区域却可能一直纯黑。视口在
`initialScrollRestored` 之前保持 `visibility: hidden`，而这个标志可能永远
不会翻开：就绪判定把滚动库大约 70px 的近底锁当成「跟底」，并要求最后一行
的盒子贴住视口底边（误差 ≤ 2px）；同时为折叠 “Worked for …” 做的跟随锁修复
让观察者在提交快照显示未跟随时不再把列表纠正到真正底部。首次滚到底现在是
一次性定位，不是跟随锁。就绪判定改用恢复意图和视口距 DOM 底部的距离。
显示之后，观察者仍然不能重新武装跟随。

## 根因

`SessionChatStreamView` 在 `initialWindowReady && initialScrollRestored` 之前
把 `[data-message-selection-scroll]` 设为 `visibility: hidden`。
`settleInitialLayout` 调用 `isInitialScrollLayoutReady(..., state.isAtBottom)`。
`state.isAtBottom` 是库的跟随锁，包含约 70px 近底容忍，就绪函数却把它当成
「最后一行已经贴底」，并用该行的 `getBoundingClientRect` 去对齐
`clientHeight - paddingBottom`，误差必须 ≤ 2px。滚动容器自身在显示前就是
`visibility: hidden` 且 `contain: strict`，子孙盒子不能当贴底信号；落在 70px
带内的恢复也会过不了 2px 检查。

另一方面，
[worked-group 跟随锁](2026-09-17-worked-group-toggle-scroll-jump.zh.md)
让几何观察者在 `wasFollowingRef` 为 false 时 `stopScroll()` 并跳过
`scrollToRealBottom()`。这在显示之后是对的。首次滚到底时，它会撤掉 2px
检查仍需要的一次性定位；hooks 规则又禁止 settle timer，于是面板一直隐藏。

可见性门本身保留。
[窗口读取对话历史](../architecture/2026-09-10-windowed-reader-integration.zh.md)
里的消融表明，拆掉它会在冷虚拟器上露出空窗或未修正的滚动位置。

## 契约

- 在 `initialScrollRestored` 之前，末尾恢复（缓存位置不是 `offset`）可以在
  跟随锁从未持有（`hadFollowedRef` 为 false）或提交快照仍在跟随时，从观察者
  和 layout 路径继续写入真正的 DOM 底部。已经跟随过再逃逸的读者即使视口仍
  隐藏也不会被拉回去。显示之前几何观察者不得 `stopScroll()`。
- 就绪用恢复意图，不用 `state.isAtBottom`。offset 恢复绝不走贴底分支。
  末尾恢复要求 `getScrollElementDistanceFromBottom <= 2`，且目标行已挂载、
  不是 Virtua 未测量状态（`style.visibility === 'hidden'`）。
- 可见底边的条目查找要减去视口上下 padding（或等价的 Virtua item-offset
  空间）。滚动容器的 `padding-top` 包含 `--conversation-top-inset`。
- 显示之后，折叠切换的契约不变：观察者不能重新武装跟随；只有滚动事件和
  显式 `scrollToBottom` 可以。

## 备选

用超时或 animation frame 强制 `visible` 被拒绝：滚动不变量禁止 settle
timer，也只是把闪一下换成晚一点闪。

拆掉 `visibility: hidden` 被窗口读取消融拒绝。

改成 `opacity: 0` 被拒绝：同一条卡住的谓词仍然不会翻开，子树还会留在
无障碍树里。

回滚折叠跟随锁修复被拒绝：展开已完成的 “Worked for …” 头会再次把读者
拽到会话末尾。

## 证据与验证

`packages/components/tests/use-sticky-scroll.test.ts` 覆盖就绪函数（末尾
恢复时最后一行盒子偏离 50px，只要 `scrollTop` 已在 DOM 底部就显示；近底
offset 恢复不必 2px 贴底；未测量目标行保持隐藏；可见底边查找减去上下
padding）以及 hook（同样两种恢复）。
`packages/components/tests/sticky-scroll-virtua.test.tsx` 仍断言显示之后
折叠收缩不能为已脱离的读者重新上锁，跟随中的读者仍停在末尾。

没有加入 timer。设备级冷开闪屏仍以
`e2e/scripts/capture-conversation-open-flicker.mjs` 为准；本次未重测。

## 取舍与限制

末尾恢复在最后一行尚未测量时仍会隐藏，这是原来的空窗保护。若 Virtua 的
`scrollOffset` 与 DOM `scrollTop` 相差超过 1px，显示仍会等待。恢复到库
近底带内某个 offset 的读者会停在该 offset，而不是被贴到末尾；他们可以
再滚动以重新锁定跟随。
