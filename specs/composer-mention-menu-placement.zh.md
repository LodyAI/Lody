# Composer mention 菜单定位

Status: draft
Translation: current

[English](composer-mention-menu-placement.md)

用户在桌面端主聊天 composer 中打开 `@`、`$`、`/` 或 `、` 菜单后，菜单跟随
当前光标并向上展开。继续输入、自动换行、滚动、调整窗口和缩放时，菜单应
更新位置。只要上方放得下分组标题和一项，筛选或菜单高度变化就不能使菜单
跳到光标下方。即使命令描述很长，菜单宽度也不超过输入区可用宽度；完整高度
放不下时，各行仍可通过滚动访问。只有光标贴近窗口上边缘、上方无法显示有用
的一项时，菜单才可向下展开。

编辑并重发的行内菜单和对话框 composer 也跟随当前光标，优先显示在光标下方，
空间不足时翻转到上方。自动换行、输入框内部滚动、布局移动和缩放后的编辑
容器不能让这些菜单停留在旧的光标位置。菜单宽度受输入区约束；若两侧都放
不下完整菜单，菜单行仍可在可见视口内滚动访问。

在较窄的移动端视口，主 composer 继续使用靠近键盘停靠的 mention 面板；
行内编辑器继续使用浮动菜单。停靠面板位于包含输入框上方附件和控件的整个
composer 框之上，且不得越过视口顶部留白。

光标测量不得改变 body 的位置选择器状态，避免在打开菜单或更改查询时触发
全页面样式重算。

## 证据

- [主 composer](../packages/components/src/components/chat/chat-composer.tsx)
- [菜单调用方](../packages/components/src/components/mentions/mention-two-level-menu.tsx)
- [光标锚点](../packages/components/src/ui/mention/mention-input.tsx)
- [Composer 定位测试](../packages/components/tests/e2e/composer-mention-placement.spec.ts)
- [光标锚点测试](../packages/components/tests/mention-ref-stability.test.tsx)
- [移动端定位测试](../packages/components/tests/mention-two-level-menu.test.tsx)
