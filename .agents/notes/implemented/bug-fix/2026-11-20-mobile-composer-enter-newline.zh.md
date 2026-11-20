# 软键盘回车插入换行

Status: implemented
Type: bug-fix
Translation: current

[English](2026-11-20-mobile-composer-enter-newline.md)

## 摘要

在手机上，聊天输入框的回车不再能换行。输入框已改为 Lexical 的 contenteditable，它会遵守 Enter 上的 `preventDefault`，而移动端回车的默认动作是发送。手机键盘没有 Shift+Enter，所以回车只能发送。手机转到宽于布局断点时，还会丢掉移动端回车设置，改用桌面的回车发送。现在软键盘的回车会插入换行，除非用户明确选择了发送。桌面的回车发送和 Shift+Enter 换行不变。

## 决定

软键盘回车是单独的策略，不跟 `useIsMobile()` 走。手持设备（手机、平板、原生壳，或报桌面 UA 的 iPad）以及被强制成移动布局的界面，遵循 `mobileKeyboardActionAtom`。存储默认值是换行。发送仍是明确选项，选中后回车仍然发送。桌面浏览器和 Electron 在任何窗口宽度下都保持回车发送、Shift+Enter 换行，包括窄桌面窗口。

调用方的 keydown 没有 `preventDefault` 时，提及编辑器自己插入这个换行。iOS 不会把 contenteditable 的 keydown Enter 变成换行，而阻止该键会吞掉浏览器本来会插入的换行。普通 textarea 仍由浏览器插入换行。带修饰键的组合（Cmd/Ctrl+Enter，包括会话输入框的反向发送）仍归调用方。

排队消息的编辑使用同一判断。软键盘动作为换行时，回车不提交编辑。

## 证据

先前的 textarea 输入框在 Enter 上调用 `preventDefault` 并发送，除非移动端动作是换行。在 iOS 上，keydown 期间的 `preventDefault` 并不能阻止 textarea 插入换行，所以回车仍然能换行。提交 `1aedcfbeb`（`feat(components): edit the composer in one Lexical contenteditable`，2026-11-11）换掉了那个 textarea。Lexical 的纯文本 Enter 处理在 iOS 上不插入换行，而是依赖 `beforeinput`；调用方若在 keydown 上 preventDefault，后续事件就不会发生。`mobileKeyboardActionAtom` 的默认值是 `send`，因此手机上回车会发送且不插入换行。

视口至少 768px 时 `useIsMobile()` 为 false，即使 UA 是手机。这是桌面布局族。回车设置接在这个标志上（`isMobile || isNativeAppShell()`），所以横屏手机不论存储的动作是什么，都走桌面的回车发送。

被放弃的做法是保留发送默认值、只修复换行动作。从未打开过该设置的人仍然无法换行。另一项被放弃的做法是继续跟随布局断点，横屏手机仍会落回桌面的回车发送。

## 范围与验证

会话与着陆输入框、提及编辑器、排队消息编辑和设置里的回退值共用这一策略。组件测试覆盖宽屏手机回车换行且不发送、明确选择发送时仍然发送、桌面回车仍然发送，以及桌面 Shift+Enter 插入换行。测试不驱动真实的 iOS 键盘；插入的是这些 keydown 所调用的编辑器命令。

## 取代检查

没有现存笔记负责软键盘回车。Lexical 编辑器笔记仍是编辑器架构的记录；它的事件处理顺序决定链接到这里。
