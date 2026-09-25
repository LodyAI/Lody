# 设置表单里的内联折叠项保持文本触发器，不用 ghost 按钮

Status: implemented
Translation: current

[English](2026-09-25-inline-disclosure-text-trigger.md)

## 摘要

供应商对话框里的「显示注入的变量」折叠项在 `@lody/ui` 迁移后脱离了表单的
文本列：触发器换成了小号 ghost `Button`，它的 `padding-inline` 把 chevron
和文字从所有字段共享的列边缘右推了约 12px。让按钮盒子按自身 padding 向左
出血可以让文字对齐，但 hover/active 的填充会凸出列边，视觉缺陷更明显。现在
触发器改回纯文本按钮，与对话框里其它折叠触发器一致：内容贴列边、hover 只
变色、焦点环仅键盘焦点出现。

## 原因与决策

迁移前该触发器是无 padding 的 inline-flex 文本按钮。`18f10b65` 把它换成
`Button variant="ghost" size="small"`，带来 `paddingInline: 10px` 和 28px 控件
高度。带 padding 的盒子只有两种对齐方式——盒边贴列（内容缩进，即被报告的
bug）或内容贴列（负 margin 让 hover 填充向左凸出，更糟）——都与周围行不符。

代码库中其它 `Collapsible.Trigger` 折叠触发器（`Section`、
`CollapsibleSection`、会话计划条）都是朴素 `<button>`，不用 `Button` 原语。
本次触发器沿用该模式（`styles.injectedTrigger`），恢复迁移前的 caption 级
外观（11px、次要色），并按包内规则用 box-shadow 做 `:focus-visible` 环。
`styles.answer` 仍包着「Download agent」secondary 按钮——那种可见盒子本来
就应以盒边对齐。
