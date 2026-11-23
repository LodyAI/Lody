# 桌面端显示 assistant 轮次的实时耗时

Status: implemented
Translation: current

[English](2026-09-17-desktop-live-turn-duration.md)

## 摘要

桌面端的对话页脚此前只有在 assistant 完成后才显示轮次耗时，因此 agent
运行期间用户看不到已经工作了多久。现有轮次时间戳和 live 耗时解析器已经提供了正确锚点，
所以桌面页脚现在复用了移动端的实时标签，只为最后一个未完成的 assistant 轮次挂载它。
轮次运行期间页脚保持可见，并通过共享时钟更新；已经不再是当前轮次的未完成旧轮次保持空白，
也不会继续订阅计时器。

## 决策

耗时以 assistant 轮次的 `timestamp` 为起点，使用当前采样时间调用
`resolveLiveSessionHistoryDurationMs`。这样 live 和 finished 标签使用同一个时间定义，
不需要把 presence 或会话元数据当成第二个精度更低的时钟。`isLive` 仍然是构建行时设置的结构性
标记，只对最后一个未完成的 assistant 轮次为真，因此新轮次创建后，已经被替代的旧轮次不会继续
显示增长的耗时。

桌面页脚沿用现有操作栏作为状态展示通道。运行期间操作栏保持可见，在操作按钮之后显示
`Worked for ...`；已完成轮次原有的时间戳和耗时行为不变。页脚渲染门控明确接受 live 轮次，
即使没有 copy 处理函数也会渲染，因此耗时显示不依赖无关的操作是否存在。

## 验证

`packages/components/tests/assistant-turn-action-inset.test.ts` 使用 fake timers 渲染真实桌面页脚，
验证 `Worked for 5s` 会推进到 `Worked for 7s`，运行中的操作栏保持可见，并验证已经不是当前轮次的
未完成旧轮次既不显示实时标签，也不显示操作栏。
`packages/components/tests/chat-virtual-rows-identity.test.ts` 验证真实行构建器在没有 copy
处理函数时仍会为 live 轮次创建页脚，且在该未完成轮次被替代后移除它。已有的解析器和移动端测试继续
覆盖共享计算逻辑和 ticker 行为。

三个定向测试文件的 24 项测试、components 类型检查、改动范围的 Oxfmt 检查和文档检查均通过。
保存分支前尝试了根目录的 `pnpm check` 与 `pnpm format`，但环境缺少 `corepack`，命令无法启动；
不将其记为全工作区检查通过。

[移动端实时耗时决策](2026-09-14-mobile-live-turn-duration.zh.md)中记录的权限等待限制仍然适用：
运行中的历史条目要到结束时才发布等待总时长，因此包含权限等待的轮次可能在结束时
向下修正一次。
