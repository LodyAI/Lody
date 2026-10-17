# 排查消息列表再次出现 React #185

Status: proposed
Translation: current

PR: [#1534](https://github.com/LodyAI/Lody/pull/1534)

[English](2026-10-13-message-list-update-depth-investigation.md)

## 摘要

用户在显示会话消息时仍偶发 React #185。源码排查将同步滚动 commit 及其可见范围到水合窗口的反馈链列为首要调查路径，但没有复现用户报告的故障。当前代码已有隐藏视口暂停、相同 offset 去重和状态相等判断。本记录提出定向复现和诊断方法，不宣称发现了确定的新根因，也没有修改运行时行为。

## 证据和候选机制

- React [185 错误](https://react.dev/errors/185) 表示嵌套更新深度超限。消息列表边界或堆栈中最后的状态更新，只能说明 React 在哪里截断循环，不一定是循环源头。
- `EngineConversationScroller` 在 layout effect 中调用 `controller.afterCommit()`。其 `ScrollHost.requestCommit` 在该 effect 内触发 reducer，在 effect 外使用 `flushSync`。`ScrollController.continueTransaction` 和 `requestCoverageCommit` 因而可以延长同步 commit 链。
- 单个事务有补充 commit 次数上限。但当行 key 或未测量的估计高度变化时，`syncRows` 会丢弃进行中的事务。这个上限不能证明不同消息行列表之间的连续事务能够收敛。
- 连接态反馈链为 `reportScroll` → `handleStreamScroll` → `reportVisibleTurnRange` → `useConversationStreamItems.onVisibleTurnRangeChange`。水合窗口变化会改变哪些 turn 显示正文、哪些显示占位行，进而改变行 key、估计高度和阅读位置。新的 offset 或范围可以通过现有相等判断。必须用合成场景证明实际回环后，才能将它认定为原因。
- 正文获取和视图通知还经过 Promise 与动画帧边界。跨这些边界的水合循环，本身不能证明会抛出 #185 的同步嵌套更新链。

## 已有保护和测试边界

[滚动引擎决策](../../implemented/architecture/2026-09-27-conversation-scroll-engine.md#hidden-viewports-2026-09-29) 记录了此前生产环境的 #185 及隐藏标签修复。当前连接态消息流会把 `isVisible` 传给 `hidden`，包括面板收起后的侧边会话。controller 跳过隐藏事务并去重相同 offset；适配器再次去重。`handleListStateChange` 使用稳定回调，比较全部三个状态字段。当前 checkout 并不缺少这些保护。

现有适配器测试覆盖隐藏标签反馈，以及每次收到滚动报告都会更新状态的消费者。它没有证明生产水合链在保存的阅读锚点、占位行展开和窗口移动组合下能够收敛。原生文本选择也会在 layout effect 中发布状态，但正常的保留检查会阻止重复发布；本次未确认选择驱动的 #185。浮层激活和流式 Markdown 还会引入子组件更新，只有捕获的组件堆栈指向这些表面时，才应优先调查它们。

## 建议的下一步验证

使用现有“复制错误报告”内容：构建版本、原始堆栈、捕获的 React 组件堆栈、session render trace 和滚动引擎 diagnostics。反复出现且目标位置或锚点变化的引擎 commit 倾向于几何反馈路径；反复出现的表面 mount/unmount 倾向于挂载所有权。若堆栈指向浮层或 Markdown 且引擎诊断安静，则复现对应子组件边界。当前成功且 covered 的事务不写入 session render trace，所以仅凭 trace 安静不能排除引擎，还需要比较 diagnostics。

在现有适配器或集成测试中加入合成 ConversationView 和保存的阅读锚点。通过显式信号切换水合，断言可见 turn 与锚点位置稳定，覆盖窗口边界附近正文与占位行的替换。不要仅靠新增定时器掩盖嵌套更新，也不要用消息数量作为 key 重挂载列表、丢失阅读状态。

## 减少 effect 反馈的设计建议

完成消息的 effect 镜像已由小范围的[派生状态改造](../../implemented/simplification/2026-10-13-completed-assistant-derived-state.zh.md) 移除。下面其余滚动和水合建议尚未实施。
另已加入[引擎更新循环保护](../../implemented/bug-fix/2026-10-13-scroll-update-loop-guard.zh.md)，通过明确的边界恢复中止合成同步更新链，但没有证明用户报告的生产根因。
该保护捕获的一次生产更新链已查明走的是水合反馈路径：[被相邻记录的水合状态分组的创建记录](../../implemented/bug-fix/2026-10-17-grouped-creation-record-anchor.zh.md)丢失了阅读锚点。其他报告的 #185 仍未解释。

参考 React 的 [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)，优先删除冗余状态和子到父的状态镜像。滚动适配器的布局测量、覆盖所需 commit、滚动写入、observer 注册和 lease 清理仍然在同步外部系统，不能变成渲染期副作用。

可以考虑用共享且身份稳定的滚动快照，替代适配器本地 sticky/revealed 状态再通过 `onStateChange` layout effect 复制到父组件的链路。顶部渐变、大纲位置和可见范围从该快照与几何 revision 派生，避免分别用回调维护副本；只发布有意义的快照变化。仅换成 `useSyncExternalStore` 不能切断同步回环：布局阶段发布仍需要收敛和相等保护。

最后完成的 assistant 身份可以由共享数据所有者提供，替代子组件在 effect 中通知父组件、父组件再存入 state。这能减少一条更新路径，但不能证明当前已有去重保护的 effect 是崩溃原因。

水合方面应在占位行与正文切换时保留阅读身份，区分用户导航和布局补偿；补偿不应无必要地重定向水合窗口。在替代窗口准备好之前，以有界所有权保留锚点和视口需要的 lease，并在实际证明范围循环后再修改淘汰行为。保留同步覆盖保证和原生选择保留机制，不应将 `useLayoutEffect` 简单换成 `useEffect`，或任意延迟一帧来规避崩溃。这些是设计建议，不是已验证修复或已采用的新契约。

## 验证限制

本次仅完成源码检查。checkout 没有安装 node_modules，未运行 React 或浏览器测试。已尝试两项要求的文档命令，都因 `spawnSync git EPERM` 失败。记录不包含用户会话转录；未修改产品代码或已评审 Spec。
