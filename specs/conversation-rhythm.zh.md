# 会话纵向节奏

Status: draft
Translation: current

[English](conversation-rhythm.md)

## 场景

用户浏览 agent 已完成的工作、阅读回答并继续追问。活动保持紧凑，回答与新一轮
对话保留呼吸感。改变界面字号后，层次关系通过既有的
[文字角色与行高](interface-typography.zh.md)保持一致。

## 间距合约

会话区域消费同一个语义化 StyleX 变量组。共享间距、圆角、颜色和文字尺度仍由
`@lody/ui` 拥有。光学缩进与图标间距保留既有固定网格；阅读与轮次间距跟随当前
界面行高。主题可以在子树内覆盖语义 token。本次不新增主题选择器或持久化功能。

设 `B` 为界面 body 行高、`S` 为 subheadline 行高，单位均为 px。阅读正文拥有独立、
可主题化的行高 `R = B × 1.2`，默认是 14px / 24px。用户气泡文本与普通 Markdown 使用
`R`，紧凑工具正文和代码保留 subheadline 行高，控件继续使用既有界面角色。消息预留区
独立跟随 `B`，因此增大阅读行高不会自动把轮次推得更远。

| 语义距离 | 公式 | 12px 字号 | 14px 字号 | 16px 字号 |
| --- | --- | ---: | ---: | ---: |
| 阅读行高 | `B × 1.2` | 20.6 | 24 | 27.4 |
| 段落间距 / 气泡上下 padding | `max(12, B - 8)` | 12 | 12 | 14.9 |
| 富内容间距 | `max(16, B - 4)` | 16 | 16 | 18.9 |
| 活动行最小 pitch | `max(24, S + 6)` | 24 | 24 | 26.6 |
| 单行列表 pitch | `max(24, R + 2)` | 24 | 26 | 29.4 |
| 用户 → 回复 | `max(32, B × 1.8)` | 32 | 36 | 41.1 |
| 回答 → 下一条用户消息 | `max(48, B × 2.8)` | 48 | 56 | 64 |

表格为方便阅读进行了四舍五入；CSS 保留小数像素。界面全部五档字号（12–16px）
均遵循这些公式。换行内容可以撑高活动行，单条工具明细的虚拟行外壳不增加 padding。
进度正文和活动摘要的块前距离使用 `proseGap = 6px`，包括展开的已完成
工作组；助手第一行仍不加顶部距离。明细保持紧凑，但工作组内的正文仍使用阅读间距。
紧凑工具正文保留自己的段落与列表节奏。

用户行拥有气泡下方的 `responseGap`，悬停与聚焦操作按钮包含在其中；助手第一行
不再额外叠加顶部间距。下一轮为用户消息时，助手最后一行拥有 `roundGap`，包括
尚未水合的用户轮次。回答的普通 footer 操作栏与下一条消息的 metadata 放在该
预留区内，不再各自累加独立空白。没有 footer 时，最后一条内容行预留同样距离；
对话末尾不增加下一轮预留区。文件修改卡片、额外或换行操作以及附件可以自然
超出最小距离，但操作必须可访问且不能重叠。测量对象为组件盒模型，而非字形边界。

Markdown renderer 拥有段落与列表间距；围栏代码和其他富内容使用 `surfaceGap`。
富内容沿用既有阅读基线。用户头像对齐气泡第一行，metadata 保持在气泡上方。
用户文本保留原始空白、chip、复制与搜索以及原生选择行为。折叠保留回答可见性、
稳定行标识和既有滚动引擎；静态与流式 Markdown 共用元素样式与阅读行高。验收包含
自动换行的连续中英文多行段落，不能仅凭单行列表或组件盒模型距离判断。

## 证据

- [会话 token](../packages/components/src/components/ai-gui/conversation.tokens.stylex.ts)、
  [共享样式](../packages/components/src/components/ai-gui/surface.ts)。
- [合成场景](../packages/components/src/stories/AssistantTurnAlignment.stories.tsx)、
  [浏览器覆盖](../packages/components/tests/e2e/interface-typography.spec.ts)。
- [决策与验证边界](../.agents/notes/implemented/simplification/2026-10-03-conversation-rhythm-stylex.zh.md)。
- [进度间距修正](../.agents/notes/implemented/bug-fix/2026-10-04-conversation-progress-spacing.zh.md)。
