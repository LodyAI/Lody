# 在 Markdown 导出中把思考排在工具细节之上

Status: implemented
Translation: current

[English](2026-09-10-conversation-markdown-export-format.md)

## 摘要

在原生 fork 不可用时，「复制为 Markdown」是会话抵达另一个 agent、机器或工作区的方式，但其降级阶梯
却按「这是一份完整记录」来排序：思考比工具调用早整整一级被丢弃，而最低一级还要为每次调用花掉多达
120 个字符，用于加粗、从词中间截断、结果早已消失的命令字符串。消息正文中的散文标题层级还高于
`## User` / `## Assistant`，因此长导出会完全丢失其 turn 结构。现在思考被截断而非丢弃，工具调用会在
此之前先折叠为每个 turn 一条带计数的摘要，正文标题被降级，turn 携带轮次编号与出处，预算提升到
15 万字符 / 6 万 token。字符上限与提升后的预算是针对合成 fixture 调优的产品判断，而不是对真实会话的
测量结果。

## 决策

导出的目的决定了价值排序。它的职责是把一段会话的**上下文**搬到别处，因此散文形态的内容——消息文本、
提出的计划以及 agent 的推理——高于围绕它们产生的一切。旧阶梯对思考的排序恰好相反。

`packages/shared/src/conversation-markdown.ts` 中的四处改动：

- `LevelConfig.includeThinking: boolean` 变为 `thinkingCap: number`。思考通过与工具结果相同的
  `clampMiddle` 降级，因此开头与结论得以保留，接收方会话总能继承部分推理。二元丢弃被否决：这是唯一
  一类「丢中间明显好过丢整体」的内容。
- 工具调用比思考截断早一级折叠，并折叠为每个 turn 一个 `<details>`，按 `toolName` 计数。仅仅把旧的
  两级对调曾被考虑，但严格更差：旧的最低级中逐调用的行本身就占预算的很大一部分，先聚合才能腾出空间，
  使多数会话根本不会降到第 5、6 级。
- `demoteMarkdownHeadings` 把消息正文中围栏之外的 ATX 标题下移两级。这是对散文的编辑，而该文件自身的
  不变量原本禁止这样做；本次是收窄该不变量而非豁免它：不删除任何字符，只添加 `#` 标记。另一条路——
  放弃用标题作为 turn 分隔——会丢掉让长篇粘贴可导航的文档大纲。
- turn 标题携带轮次编号、本地 `MM-DD HH:mm`，对 assistant turn 还携带记录的模型与有效工作时长；每个
  新轮次以一条分隔线开始；头部引用块携带时间范围、仓库/分支、模型与裁剪提示。该提示从页脚移到了页首，
  因为它的读者常常是另一个 agent，需要在阅读之前就知道这份记录并不完整。发言人名称只有在会话包含
  多于一个不同 `userId` 时才进入 turn 标题；在单人会话中反复重复一个名字只是噪声；`userId → 名称`
  的映射由调用方提供，因为 `@lody/shared` 无法解析它。

同样的推理后来也吸收了 #558 追加在文档之后的「最后一条回复仍在生成」警告：它现在是由调用方本地化的
字符串，经 `incompleteFinalResponse` 传入并渲染在头部块中。关于记录完整性的两条提示分散在不同位置，
其中一条还位于它所限定的内容之后——这正是本组改动要消除的缺陷。

`describeTrim` 明确说明折叠会丢弃结果与终端输出，而不是去累加逐块的计数。被折叠的调用根本不会到达
块渲染器，因此那些计数器保持为零；为了让提示看起来准确而伪造它们，只会让统计撒谎。

预算从 5 万/2 万（字符/token）提升到 15 万/6 万。旧上限早于当前的上下文窗口，也正是普通会话会触底的
原因。密钥脱敏仍然只覆盖终端输出与工具结果，并刻意不覆盖消息文本：fork 会话的用户希望自己粘贴进去的
材料能随之迁移。

`buildReplayPromptFromHistory` 未被触碰。它是面向 agent 的重放 prompt，其预算行为对 CLI resume 至关
重要，并保留自己的 `thinkingOmitted` 语义。

## 证据与限制

`packages/shared/tests/conversation-markdown.test.ts` 用 24 条断言覆盖新行为，包括：标题降级保持围栏
内的 `# comment` 行不变并在 h6 处钳制；折叠发生时思考仍未被触碰；思考被截断并带 `characters elided`
且该块在最低级仍然存在；轮次编号且每个新轮次恰好一条分隔线；由 `endedAt - timestamp - permissionWaitMs`
推导出的模型与 `4m12s` 工作时长；两个 `userId` 时出现发言人名称、一个时不出现；以及裁剪提示位于第一个
turn 之前。压缩预算的测试直接驱动 `maxChars`，而不是构造大到能触发真实上限的 fixture。

`pnpm --filter @lody/shared --filter @lody/components run typecheck` 通过。验证基于 fixture：没有把真实
会话导出后粘贴进另一个 agent，因此「新头部与逐 turn 元数据有助于接收方模型」这一说法是推理而非实测。
2000/500 的思考上限与 15 万/6 万的预算是对照这些 fixture 选定的起始值，应结合真实会话数据重新评估。

完整规则文本在 `.agents/docs/sessions-surface.md`；具约束力的一行规则仍留在
`packages/components/src/components/sessions/AGENTS.md`。目前没有 Spec 拥有该界面，因此未更新任何 Spec。
