# 本地队列折叠

Status: proposed
Translation: current

[English](2026-10-08-queue-local-disclosure.md)

## 摘要

始终展开的队列占用会话空间。默认展开的本地折叠控件允许用户收起列表，不改变发送，
也不丢失编辑草稿。待准备与失败数量仍可见；浏览器和真机验收仍待完成。

## 决策与依据

现有折叠控件让行保持挂载。焦点移到标题时跳过普通失焦保存，保留未完成的编辑。
数量订阅现有本地发送投影，不共享或持久化折叠状态。
本次扩展[本地队列行](../../implemented/feature/2026-09-28-local-queue-pending-rows.zh.md)，
遵循[队列意图](../../../../specs/message-queue.zh.md)。所属编辑测试覆盖折叠再展开时的草稿连续性，
以及实时待准备和失败数量；折叠上传故事使用真实展示组件。
