# 忽略已关闭对话的未读输出

Status: implemented
Translation: current

[English](2026-09-21-closed-conversation-unread.md)

## 摘要

已关闭对话仍显示未读圆点并参与未读汇总。未读展示现在先依据现有关闭／归档标记，再比较
消息和已读时间。不写入已读回执，也不增加状态，因此历史已关闭对话及关闭后的新输出均
保持安静。重新打开恢复正常未读判断；运行中和等待权限提示继续保留。

## 决策与证据

本改动延伸[共享标签关闭](../feature/2026-09-16-shared-tab-closure.zh.md)及其
[草案规范](../../../../specs/session-tab-closure.zh.md)。关闭时仅标记一次已读，无法抑制后续输出，
也无法处理历史已关闭标签。`sessionHasUnreadMessages` 统一负责标签、已关闭列表、侧栏／任务
汇总、项目未读数和窗口角标。主对话关闭后，仍打开的子会话继续贡献未读。

回归用例覆盖关闭／重开、后续输出、父级汇总、权限状态及已关闭列表渲染。
当前工作树未安装依赖，定向 Vitest 测试及组件类型检查无法启动（缺少 `vitest` 和 `tsgo`）。
独立运行 Vitest 3.2.4 后，9 个已读／未读测试全部通过；直接 Node 断言也验证了生产函数。
格式化和 `git diff --check` 通过。文档检查报告已有的缺失 ACP 子模块链接；尚未进行原生界面验证。

## 已关闭列表的未读标记

全部抑制后，已关闭标签里的新输出无从发现。现在只要列表中有对话的输出晚于其
`lastReadAt`，顶栏的已关闭列表按钮右上角就显示小圆点，对应行用未读圆点代替 Agent 图标。
`closedSessionHasUnreadMessages` 只对已关闭／已归档对话做同样的时间戳比较；
`sessionHasUnreadMessages` 在其他位置（包括桌面端侧边栏和手机端 Session 列表）继续抑制它们。从未读过且有消息的已关闭对话算作未读，
与打开的标签一致。由已读回执和标签栏测试、`Unread output in a closed tab` Story 覆盖，
并已在 Storybook 中检查两种主题。
