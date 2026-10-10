# 消息队列展示

Status: draft
Translation: current

[English](message-queue.md)

## 场景

Agent 工作时，待发送消息显示在输入框上方。用户可以折叠列表，腾出会话空间，
再展开查看或编辑消息。

## 行为

- 标题是可通过键盘操作的折叠控件，显示包含本地附件准备中消息的总数。
  默认展开；状态仅保留在当前挂载的展示组件中，不共享，也不持久化。
- 折叠只改变展示，不发送或删除消息、不改变顺序，也不提交或丢弃尚未完成的
  行内编辑。重新展开后保留草稿。新增消息只更新数量，不自动展开列表。
- 折叠时仍显示准备中与未发送的数量。展开后可使用原有重试、取消操作。
  本地待发送行仍不参与排序，也不增加编辑或引导操作。

## 依据与限制

[队列展示组件](../packages/components/src/components/sessions/message-queue/message-queue-display.tsx)
复用现有折叠控件与编辑状态。[所属测试](../packages/components/tests/message-queue-row-editing.test.tsx)
覆盖编辑连续性和折叠时的实时数量。Storybook 包含折叠上传状态。
浏览器与真机验收尚未验证。
