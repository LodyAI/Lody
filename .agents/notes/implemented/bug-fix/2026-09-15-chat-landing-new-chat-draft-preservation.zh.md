# Chat Landing 在“新建对话”导航时保留草稿

Status: implemented
Translation: current

[English](2026-09-15-chat-landing-new-chat-draft-preservation.md)

## 摘要

本地项目的“新建对话”会通过 URL 指令清空已有 Chat Landing 草稿，而其他项目入口都会复用工作区草稿。
现在“新建对话”导航只改变目标项目，同一工作区内所有 Chat Landing 入口都复用同一份 Composer 内容。
首条消息成功写入后仍会清空草稿，不同工作区之间也继续保持隔离。

## 问题

侧边栏进入同一项目 Landing 原本有两条路径。点击项目行只携带项目选择并保留草稿，而点击“新建对话”按钮
还会附带新的 `resetDraftKey`。`chat-landing.tsx` 把该 key 解释为清空指令：用空值替换已持久化的文本、
粘贴文本状态和 mention ranges，同时释放附件和预留 Session id。因此，用户切到已有 Session 后再通过
“新建对话”返回时，未发送的输入会被销毁。

该问题不同于[工作区窗口草稿修复](2026-09-11-workspace-window-composer-drafts.zh.md)：存储 key 的作用域已经
正确，但其中一条导航路径会主动删除该 key 下的值。

## 决策

- 每个工作区只有一份 Chat Landing 草稿，不因所选项目或进入 Landing 的新对话入口而改变。
- 本地项目的“新建对话”按钮复用普通项目 Landing 的导航回调。不再保留 URL 级草稿重置指令，也不再通过
  mount effect 把导航解释成清空操作。
- 项目选择仍属于路由状态，可以改变，但不改变草稿归属。
- 首条消息成功写入仍是自动释放草稿的边界；用户仍可显式删除单个附件。

没有为每次点击“新建对话”保留独立空白草稿，因为这与唯一可见的 Chat Landing Composer 冲突，并会让
未发送文本变得不可达。也没有只保留附件重置：文本、粘贴内容、mention ranges、附件和预留 Session id
共同组成一次提交草稿，不能被导航拆分。

本决策细化了[桌面窗口 Spec](../../../../specs/desktop-windows.zh.md)中的草稿保证；该 Spec 仍为等待人工审阅
的 draft。

## 验证

组件草稿测试证明工作区所属的 prompt 能在 Landing 卸载和 Jotai store 重建后从持久化存储恢复。路由解析
测试拒绝已经移除的 reset 指令，确保项目选择和旧 URL 都无法恢复破坏性行为。

- `pnpm --filter @lody/components exec vitest run tests/chat-landing-draft-persistence.test.tsx tests/chat-landing-derived.test.ts tests/chat-landing-selection-url-sync.test.ts`
- `pnpm --filter @lody/components typecheck`
- `pnpm lint`（在外层 workspace 执行）
- `pnpm run docs check`
