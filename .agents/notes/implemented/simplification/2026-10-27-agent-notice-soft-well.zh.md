# Agent 提示去掉描边，改为软色块

Status: implemented
Translation: current

[English](2026-10-27-agent-notice-soft-well.md)

## 摘要

`agent_warning` 和 `chat_failed` 原本共用一个整列宽的 tint 卡片和一圈 0.5px 的语义色描边。会话里的其他表面都是无描边的软填充，这圈描边让提示成了唯一的“带框组件”，像从外面贴上来的一层 chrome。现在提示改用与用户气泡、代码块相同的材质：约 4.5% 语义色填充、无描边、图标与标签居中对齐、13px 小标题字号，正文从色块的左侧起始边开始。始终展开、整列宽、复制和重试行为都保持不变。代价是 warning 更安静，状态主要由图标、标签和轻色块承担。

## 决策

用户在 Ryugi 决策画板上对比软色块、左侧色条和行内句子后选择了 A，并评论要求：图标与文字对齐；描述部分不要缩进；失败态的复制按钮要保留。

`AgentNoticeBanner` 现在：

- 头部一行使用 `alignItems: center`：14px 图标、13px/18px 中等字重标签，以及最多一个尾部动作（有重试时是重试，否则是复制）。
- 正文作为独立块从色块左侧起始边开始（`padding-inline: space[3]`），不再缩进到标签下面；字号 13px/20px，颜色 `--muted-foreground`。
- 4.5% 语义色填充（`--destructive`、琥珀色或 `--muted-foreground`），没有 ring 或 border。标签保留语义色，正文保持 muted 的文字层级。
- 复制只有在它是唯一尾部动作时才上头部；有重试时重试占头部，复制保留自己的底部一行。

字号从 footnote 提升到 subheadline，与会话活动时间线一致，不再比周围文字更小。

## 备选方案

- **左侧色条**（2px 竖线，无填充）：更安静、更编辑化，但会话里没有左侧竖线这个视觉 primitive，等于只为失败态新增一种材质。
- **行内句子**（无表面，标签和正文同一行）：最贴近透明时间线，但长 provider payload 会变成一段没有边界的普通段落，失败态偏弱。

也考虑过保留描边但把标签改成中性色；它仍然是会话里唯一的带框块，没有解决材质不一致。

## 验证

Storybook 在 845×760（桌面深色和亮色）、760×250（长文本和多行 agent 文本）以及 390px（warning 和 failure）下抓取了实现后的软色块；Ryugi 画板 check 为 0 warnings。组件 typecheck 通过，`@lody/components` 全量测试通过（622 个文件、6262 个测试），并用 Playwright 点击手机失败态的复制按钮，从剪贴板读到了预期的 `Error details:` 报告。未验证：打包后的 Electron 实机流程，以及提示上的原生文本选择。旧的“整列宽”记录继续拥有宽度和折叠的决策；其中关于 ring/fill 的句子由本记录取代。
