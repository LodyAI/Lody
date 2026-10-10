# 会话滚动

Status: draft
Translation: current

[English](conversation-scroll.md)

## 场景

用户打开会话、阅读内容、在输入框中输入并发送消息，同时 Agent 的回复持续生成。
会话应展示用户想看的内容，仅在用户操作或新输出到达要求时移动。

## 行为

- **跟随末尾。** 在末尾打开会话或主动滚回末尾后，视图随输出增长保持在末尾。
  输入框高度、移动端键盘或停靠面板变化时，也保持在末尾。
- **阅读其他位置。** 用户通过滚轮、按键、滚动条或触摸上滚时，立即停止跟随。
  新输出在下方增长，不移动正在阅读的内容。消息内代码块或终端的滚动不算会话
  滚动。“滚到最新”控件恢复跟随。下方仍有 Agent 实时输出时显示工作指示器；
  等待权限或没有实时工作时显示向下箭头。鼠标悬停或键盘聚焦控件时，即使仍在
  工作也显示向下箭头；离开后恢复工作指示器。滚动操作本身不变。
- **空闲时发送消息。** 平滑地将已发送消息滚到视口顶部，留出下方空间用于回复；
  系统要求减少动态效果时立即定位。回复先填充空间，不移动该消息，触及底部后
  恢复跟随末尾。若用户中途上滚，留白随滚动释放，不再补回；下滚到达回复的真实
  末尾。消息比视口高时，改为展示其末尾。
- **排队或引导消息。** Agent 工作时发送这类消息不会移动视图。
- **加载。** 会话有消息但本设备尚无内容时，显示消息骨架，不留空白面板。
  有本地副本则立即展示；首次打开仍在追赶服务端时，信息栏显示“更新中”。
  会话正文不增加内容。很快完成的常规打开不显示状态；状态需持续一小段时间才
  出现，出现后保留足够时间以免闪烁。连接中断不在此提示，重连自动进行。
- **切换标签页。** 切走后会话继续接收输出。切回时保留离开前的位置：此前跟随
  则显示最新输出，否则保持同一行位于顶部。
- **打开。** 第一帧就展示会话，之后不隐藏。此前跟随时在末尾打开；此前阅读其他
  位置时，把同一行放到顶部，即使上方内容已变化。首帧已在正确位置，不闪过中间
  位置；尚在测量的行不会让视口空白。
  参见[滚动引擎](../.agents/notes/implemented/architecture/2026-09-27-conversation-scroll-engine.md)。

## 待确认问题

- iOS 上，触摸惯性滚动中的位置校正会结束惯性滚动。其影响由释放触摸后的引擎
  惯性计数决定，参见[滚动引擎记录](../.agents/notes/implemented/architecture/2026-09-27-conversation-scroll-engine.md#write-forms)。

## 依据

- 实现：`packages/components/src/lib/conversation-scroll/`、
  `packages/components/src/components/ai-gui/conversation-list/engine-conversation-scroller.tsx`、
  `packages/components/src/components/ai-gui/view.tsx`。
- 测试：`packages/components/tests/conversation-scroll-engine.test.ts`（模型）、
  `engine-conversation-scroller.test.tsx`（适配器）、`conversation-viewport-contract.test.tsx`，
  以及浏览器用例 `tests/e2e/conversation-scroll-engine.spec.ts`、
  `session-chat-hydration.spec.ts`（Storybook、Chromium）。尚未在运行中的桌面应用或 iOS 上验证。
