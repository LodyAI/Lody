# 主聊天 composer 的 mention 菜单跟随光标并向上展开

Status: implemented
Translation: current

[English](2026-09-29-main-composer-mention-above-frame.md)

## 摘要

主 composer 的 mention 菜单跟随光标；只要上方能显示有用的一项，就保持
向上展开。较长的命令描述不再把菜单撑到整个桌面宽度。

## 决策

主聊天 composer 指定 `menuSide="top"`，但保留光标锚点。固定到
`[data-mention-frame]` 虽然使长菜单位于输入框上方，却让用户打字时补全菜单
留在原处；浏览器测试测得光标已移至 x≈445px，而菜单仍停在框体的 x=336px。
框体锚点仍可供其他调用方显式使用，也仍供移动端停靠面板定位，但桌面端主菜单
不用它。

浮动定位器会写入按视口计算的内联 `max-width` 和 `max-height`。前者覆盖了
输入区宽度上限：2048px 桌面上，1422px 的输入区遇到很长的合成命令描述，
菜单会被撑到 2048px。现在输入区宽度上限优先。定位器还会在上方能容纳多行
时，仅因完整菜单太高就把它翻到光标下方。显式向上的光标菜单现在按上方空间
限高；此上限优先于定位器写入的内联高度，同时保留碰撞处理，让菜单在输入区
内水平调整。只有上方连标题和一项都放不下时才退到下方。行内编辑器和对话框
等默认光标菜单仍优先向下，并在空间不足时翻转。

## 验证

Playwright 测试在会话 composer 中使用 24 条合成命令。2048×1098 视口下，
长描述在修复前复现横向溢出，修复后菜单保持在 1422px 输入区内。测试还覆盖
光标移动、600px 高桌面中长列表在筛选和退格时保持向上、上边缘回退、滚动与
键盘选择、焦点、窗口缩放、编辑器缩放，以及移动端宽度下的行内编辑器。
修复前后截图使用同一宽屏视口。此前 650×250
截图不适合作为桌面窗口证据（桌面窗口最小高度为 600px），现由宽屏证据
替代。尚未验证打包后的 Electron 应用。

## 链接

- [定位 Spec](../../../../specs/composer-mention-menu-placement.zh.md)
- [Composer 调用方](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [定位测试](../../../../packages/components/tests/e2e/composer-mention-placement.spec.ts)
- [PR #1140](https://github.com/LodyAI/Lody/pull/1140)
