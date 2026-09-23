# 对话字号改为五档命名

Status: implemented
Translation: current

[English](2026-09-19-conversation-font-size-tiers.md)

## 摘要

对话字号设置从八档像素刻度（8–32px）收缩为五档命名——更小、小、默认、大、更大，
对应 12–16px——因为可用的对话字号本来就集中在这一区间，极端值更像是缺陷而非
选项。滑块和示例文本预览一并去掉：命名选项本身已经表达意图，不需要再用预览去
解释一个数字。桌面端复用 `PreviewSelect`，移动端使用与语言行相同的内联选择器，
两端共用同一份标签列表。

## 决策

本条取代[滑块记录](../bug-fix/2026-09-15-conversation-font-size-slider.md)中的
交互方式，并收窄[固定刻度记录](2026-09-14-conversation-font-size-scale.md)中的
刻度：`CONVERSATION_FONT_SIZES` 由八个像素值改为五档命名，
`conversation-font-size-options.ts` 是唯一的标签来源，桌面和移动端不会对同一个
存储值给出不同描述。

`normalizeConversationFontSize` 的持久化契约不变——旧版本写入的数字吸附到最近的
档位（例如保存的 24 落到最接近的 16），旧的预设字符串仍会迁移。
`ConversationFontSize` 仍是数字，所有读取方无需改动。

移除预览和说明文字是有意的：命名档位不需要示例句，整个区块也回到与主题、语言
一致的单行形态。数字输入依旧不回归——逐键截断会破坏多位数编辑，而旧的大范围
也只提供了不可用的字号。

## 验证

外观套件断言五个标签按序出现且选中即生效；移动端套件覆盖上下限与持久化重载；
归一化套件锁定新刻度与吸附行为。未覆盖：打包后的原生应用检查。
