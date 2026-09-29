# 恢复 composer mention 菜单的光标定位

Status: implemented
Translation: current

[English](2026-09-29-composer-mention-follows-caret.md)

## 摘要

桌面端 composer 的 mention 菜单一直对齐输入框；光标移动后，候选菜单会远离正在
编辑的文字。现在菜单默认使用现有的光标定位，优先显示在光标下方，并在空间不足时
翻转到上方。虚拟锚点也从触发符位置改为当前插入点，因此输入查询内容时菜单确实会
随之移动。浏览器探索随后又发现自动换行坐标错误、布局移动未跟随、高菜单越出
屏幕，以及移动端面板遮住输入框上方控件的问题；这些边界现按实际排版和可见
frame 修正。

## 决策与代价

`MentionTwoLevelMenu` 为主 composer 和行内编辑器默认使用 `anchor="caret"`、
`side="bottom"`。`MentionInput` 在输入或选择位置变化时，以当前插入点更新锚点。
旧的 `textWidth % inputWidth` 估算无法处理按词换行，真实浏览器中的横向误差达到
74px；现在使用不受容器缩放影响的临时镜像测量光标，再映射到输入框滚动和
缩放后的坐标。虚拟锚点将 textarea 指定为 `contextElement`，让浮动定位在
光标不变、布局却移动时也能观察到变化。

固定到 composer 的模式仍可供调用方显式选择。主 composer 重新标记 frame，
但默认只有移动端停靠面板使用它：附件与控件应位于面板下方，而非被遮住。
停靠面板观察 frame 大小变化，并按其上方实际空间限制高度。光标菜单通过
`fitViewport` 限制过高的浮层，并允许浮层滚动。`MentionContent` 包装层也
改为保留调用方的内联样式；此前 StyleX 的空 `style` 会覆盖它，导致滚动
样式无法生效。

之前的 [composer frame 决策](../feature/2026-09-25-composer-mention-menu-v2.zh.md)
避免了较短的一级菜单与较高的二级菜单在光标上下跳动，或覆盖 mention chip。
恢复光标定位意味着菜单可能在切换层级时翻边；相应收益是候选项贴近正在编辑的
文字，同时继续使用现有的视口碰撞处理。后来的
[固定上方修复](2026-09-26-mention-menu-pinned-above-input.zh.md)保留为 frame
锚点设计的历史记录。

## 验证

Chromium 中的真实 Storybook 菜单跟随自动换行的 `@` 查询光标（x≈414px），
在底部 composer 上方翻转，在 650×250 桌面视口仍可滚动访问，并能通过鼠标
和键盘提交候选项。390×640 的移动端 Storybook 菜单位于整个 frame 上方，
选择二级 Issue 后仍保持 textarea 焦点。使用同一 primitive 的最小页面在
修复前复现了换行偏移（光标 x≈616px、菜单 x≈542px），修复后对齐；布局
移动和移动端 frame 修复也做了前后验证。390×250 的极端视口中，移动端面板
现在按顶部留白以上的实际空间裁切，而不再大部分越出屏幕；该几何空间无法
同时容纳完整菜单行、composer 和顶部留白。

行为测试覆盖虚拟锚点的当前位置和观察目标、包装层样式透传、以及移动端
frame 停靠与高度限制。选定的组件测试全部通过（41 项）。本 checkout 尚未
验证 release web 部署。

## 链接

- [定位 Spec](../../../../specs/composer-mention-menu-placement.zh.md)
- [编辑重发决策](../feature/2026-09-28-edit-resend-mentions.zh.md)
