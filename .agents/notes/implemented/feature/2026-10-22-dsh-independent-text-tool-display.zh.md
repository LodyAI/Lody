# DSH 文字与工具独立展示

Status: implemented
Translation: current

[English](2026-10-22-dsh-independent-text-tool-display.md)

## 摘要

Lody 将 DSH 思考和工具放进同一组，因此原本展开的纯思考组可能在工具加入后收起。
适配器没有混淆正文与推理类型；正文在每条 assistant 消息提交时发送，并非只在整轮结束时发送。
DSH 文字现在独立可读，工具默认显示折叠摘要，同时保留思考语义和用户手动开合。
DSH 不再使用外层已完成过程折叠，以保持原有顺序。适配器流式传输与持久化历史保持不变。

## 证据与职责

- 当前 `acp-extension-dsh` 固定提交为 `fed5474fa2f259df6cc94d935c8139d81aeee699`，
  Harness 版本为 `0.2.1-rc.2`。`src/adapter.ts` 将 reasoning delta 发送为
  `agent_thought_chunk`，已提交的正文发送为 `agent_message_chunk`，忽略实时
  `text-delta`。现有 `src/adapter.test.ts` 记录了这两条路径。
- Lody 的[分组构建器](../../../../packages/components/src/components/ai-gui/assistant-turn-render-blocks.ts)
  合并相邻思考和工具；[虚拟行构建器](../../../../packages/components/src/components/ai-gui/view.tsx)
  仅默认展开 DSH 的纯思考组。完成后，过程内容还可能被外层 worked 折叠组隐藏。
- 2026-10-22 检查的上游 Web `master` 在
  [AssistantMarkdown](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx)
  展示普通 Markdown，在
  [ReasoningRow](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/chat/ReasoningRow.tsx)
  独立折叠思考，在
  [ToolRow](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx)
  独立折叠命令、输入和结果。`use-disclosure.ts` 默认关闭各个折叠行。
  运行中的思考预览最近已完成段落的首行，结束后的预览由 `presentation-policy.ts`
  控制；该策略也支持整轮过程折叠。此处对比不代表适配器固定版本具有完全相同的行为。

## 实现与限制

只有 Session 元数据标识的 builtin DSH 启用独立思考布局。思考与工具之间的边界
结束当前活动组，工具加入时保留前组的键。思考组默认展开，工具组默认收起；保留
手动开合和搜索展开。DSH 跳过外层已完成过程折叠，保持中间正文可见及工具的原有
位置，耗时由已有页脚展示。布局和虚拟行缓存均包含 Provider 策略；其他 Provider
保留原有行为。

相比上游 Think 折叠预览，这会占用更多纵向空间，但符合中间文字可直接阅读的要求。
没有修改存储类型或 Provider 传输。普通正文仍等每条消息提交后发送；改成实时流式
输出需要另行处理重试、中断和去重。

本次调整修订[思考可见性 Spec](../../../../specs/deepseek-thought-visibility.zh.md)中的
混合组展示，并补充[此前调查](../bug-fix/2026-09-27-dsh-thought-text-visibility.zh.md)。
现有 Storybook 对齐用例增加了一个合成的已完成 DSH 示例。

## 验证

常规分组测试通过 13 项。通过临时 AST 验证配置加载实际的行构建、缓存、比较、分组
及辅助函数声明，排除无关 UI 渲染器后，三个归属测试套件共通过 33 项。
覆盖工具流式加入、独立开合、搜索展开、完成和中断输出、Provider 与缓存切换，以及
已有计划分段。隔离运行没有用 mock 替换行为函数。

嵌套工作树没有安装依赖图。临时复用的依赖无法运行完整 UI 套件（缺少
`@pierre/highlights`，UI 导出过旧），包类型检查也被更广泛的缺包及版本差异阻塞。
临时链接已移除。未宣称桌面视觉验证或完整构建通过。文档检查存在未检出子模块造成
的既有链接错误，本次文档未报错。修改代码通过定向 lint 和差异空白检查。
