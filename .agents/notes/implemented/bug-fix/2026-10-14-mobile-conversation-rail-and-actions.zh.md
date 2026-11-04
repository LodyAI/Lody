# 移动端对话左轨、轮次间距与消息操作

Status: implemented
Translation: current

[English](2026-10-14-mobile-conversation-rail-and-actions.md)

## 摘要

手机上的对话原本有三条左边缘，轮与轮之间挤在一起，并且每条消息下面都常驻复制、
信息、分叉、编辑、置顶按钮。现在所有内容都从正文左轨开始；轮次间距放在移动端
footer 下方而不是包住它；只有最新的助手轮次常驻按钮，点按其他消息会显示该消息的
按钮，同一时间只显示一条。代价是旧消息的操作需要多点一下。

## 证据

手机截图（CSS 宽 402px）中，正文距屏幕边缘 18px，footer 的 "Worked for …" 为
14px，移动端折叠箭头字形约 22px，其标签（"Ran 3 commands"）为 38px。原因：

- 移动端操作栏没有使用 `conversation.railInset`。
- `ProcessDisclosureButton` 仅在移动端把箭头放在标签前，标签因此右移一个箭头加间距，
  展开后的步骤（在左轨上）也不再与标题对齐。
- 移动端实时状态（`AgentActivityStatus`）丢掉了 4px 左内边距。

节奏 Spec 让 footer 操作位于 `roundGap` 预留区内。桌面端操作默认 `opacity: 0`，
这样成立；但移动端 footer 常驻，它与下一条用户时间戳之间的可见距离只剩约 17px。

## 决定

- 统一左轨：移动端操作栏加上 `conversation.railInset`；折叠标题在所有布局中都先显示
  标签、箭头在后（触屏常显）；移动端实时状态保留左轨内边距。
- 移动端结束一轮的 footer 行使用 `roundLastRow`（预留区在 footer 下方），而非
  `roundFooter`（预留区包住 footer）。Spec 已同步记录。
- `mobile-message-actions.ts` 在外部 store 中保存唯一被展开的消息 id；每行只订阅自己的
  布尔值，一次点按只重渲染两行。点在链接、控件、操作栏上或正在选择文本时不切换。
  隐藏的按钮使用 `invisible`，展开不会改变虚拟列表的行高。最新助手轮次以及正在分叉的
  轮次保持按钮可见。耗时槽位（及其边缘返回手势内缩）保留。

考虑过的方案：长按菜单（与对话依赖的原生文本选择冲突）；所有轮次都隐藏按钮（会藏起
最常用的操作——复制最新回答）。

## 验证

`tests/assistant-turn-action-inset.test.ts` 覆盖默认可见性、单条展开与点按过滤。
`AssistantTurnAlignment.MobileConversationRhythm` 在 390px 宽的 Chromium 中测得正文、
折叠标签与 footer 标签都在 18px。未在 iOS 真机上验证。
