# 可配置的 Send and Steer 快捷键

Status: implemented
Translation: current

[English](2026-10-07-configurable-send-and-steer-shortcut.md)

## 摘要

保持 queue 默认行为的用户希望用一个键（例如 Cmd+Enter）始终引导（steer）正在忙碌的
prompt，而不必记住 Cmd+Shift+Enter 当前是反转为 steer 还是 queue。新增可重新绑定的
命令 Send and Steer（`session.sendSteer`），以 guide 的 `submitBehavior` 覆盖发送当前
聚焦的会话草稿；提交路由解析器在现有全部 steer 守卫下应用该覆盖。该命令默认不绑定，
避免改变用户习惯的 Cmd+Enter；用户在键盘快捷键设置页自行绑定。命令只在可见会话输入框
获得焦点时执行，因此绑定不会发送隐藏草稿，也不会抢占其他文本框的 Cmd+Enter。

## 问题与决策

[反转发送](2026-09-18-per-row-queue-steer-and-inverted-send.zh.md) 只提供一个硬编码组合键，
其含义取决于当前偏好。输入框发送仅存在于本地 `onKeyDown`，无法修改或新增绑定。

- 命令放在共享 registry 中，因此出现在设置页，并复用录制、冲突检测和跨窗口持久化。
  内置占位注册保证没有会话输入框挂载时它仍会列出。
- 解析器用一个 `behaviorOverride` 取代配置的偏好。命令传入 `guide`；Cmd+Shift+Enter
  改为在输入框按键时算出偏好的反面并传入，不再使用单独的 `invertBehavior` 标志。
  `forceQueue` 和 `forceDirect` 仍然优先。steer 仍需要
  权威的 acknowledged-steer 支持、正向的实时 prompt 活动以及未完成的 assistant turn；
  否则按普通 queue 或直接发送路由处理。
- 绑定级 `when` 不作用于用户覆盖，而该命令只有用户绑定。因此命令级 `when` 检查输入框
  textarea 是 `document.activeElement` 且提及菜单未展开，重新绑定为纯 Enter 时仍能选择提及项。
- registry 在 window capture 阶段先于输入框处理器分发。输入框处理器现在忽略已被
  prevent 的 Enter 事件，Cmd+Enter 或重新绑定的 Cmd+Shift+Enter 不会发送两次。registry
  对所有命令忽略 IME 组字中的 keydown。

## 备选方案

- 在 `invertBehavior` 旁再加一个 `forceSteer` 标志：评审时否决。两个重叠的标志需要
  额外的优先级规则，而一个覆盖值就能表达同样的意思。埋点字段 `invert_behavior` 改为
  `submit_behavior_override`。

- 默认绑定 `Mod+Enter`：已拒绝。Cmd+Enter 已按配置行为发送，静默改变肌肉记忆按键会改变
  忙碌发送的路由。
- 改为让现有反转组合键可重新绑定：仍无法提供与偏好无关的“始终 steer”按键，而这正是用户需求。
- 命令面板：面板输入框会获得焦点，焦点范围的 `when` 会在面板中隐藏该命令。它是输入框按键，
  不是导航动作。

## 限制与验证

- 同一渲染进程有两个可见会话输入框时，只有最近挂载的注册拥有该命令；目前保留的标签页
  会传入 `isVisible=false`。
- 被适配器拒绝的强制 steer 与反转 steer 一样降级为普通的下一轮，并排在先前的队列行之前。
- 由路由解析器、registry IME 以及挂载真实 `CommandShortcutHost` 的输入框集成测试验证。
  未在真实 agent 上执行 steer。

## 证据

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/lib/commands/{registry,shortcuts,built-ins}.ts`
- `packages/components/tests/{session-message-submit-route,commands-registry}.test.ts`、
  `packages/components/tests/session-chat-input-submission.test.tsx`
