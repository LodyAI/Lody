# 保留上一条排队消息确认返回后的下一条编辑内容

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1533

[English](2026-10-13-queued-edit-operation-ownership.md)

## 摘要

用户连续编辑两条排队消息时，第一条保存的确认可能清空第二条草稿。编辑框仍然可见，但内容恢复成第二条消息的原文。现在每次编辑操作都有独立身份，只有最新操作可以更新本地编辑状态或等待状态。Playwright 在修复前复现了输入丢失，修复后验证了文本、焦点和两条最终保存结果；验收使用生产组件与合成数据，未运行构建后的桌面应用。

## 根因与决策

点击下一条消息会让当前编辑框失焦并保存。生产保存回调先写入排队消息，再等待第一条消息的同步确认，因此旧回调仍未结束时，下一条编辑框已经可能打开。此前旧回调无条件清空本地编辑状态，同步的编辑标记随后用下一条消息的原文重新打开编辑框。

`useMessageQueueEditing` 为开始、取消和保存操作分配身份。只有身份仍然有效的完成回调可以修改本地状态。卸载会使身份失效；过期的开始操作也不会继续发起下一次写入。队列写入、同步、失焦自动保存和错误反馈继续由现有逻辑负责。等待确认期间禁用其他消息会打断连续编辑；明确操作归属可以保留现有流程。

本决策补充[编辑框焦点决策](2026-09-12-composer-click-focus.md)，不改变其光标或底部操作行为。

## 证据与限制

- [编辑状态归属](../../../../packages/components/src/components/sessions/message-queue/use-message-queue-editing.ts)与[生产回调](../../../../packages/components/src/components/sessions/session-chat-interface.tsx)。
- [队列组件测试](../../../../packages/components/tests/message-queue-row-editing.test.tsx)通过显式信号控制确认，覆盖下一条开始操作仍在等待时旧确认返回的情形。
- [浏览器回归](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)通过[延迟确认 story](../../../../packages/components/src/stories/MessageQueueDisplay.stories.tsx)操作真实队列组件。4 个聚焦队列的浏览器用例在 Chrome 中通过。修复前后截图位于忽略提交的 `artifacts/usability/`。
- 修改文件通过 Oxlint。已尝试包类型检查与桌面构建，但未修改模块的依赖缺失或版本不匹配阻止了检查，包括 Office/PDF 预览及 CLI 的 MCP/WebRTC 依赖。尚未验证已安装桌面应用与真实 daemon 同步。
