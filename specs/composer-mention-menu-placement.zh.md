# Composer mention 菜单定位

Status: draft
Translation: current

[English](composer-mention-menu-placement.md)

用户在桌面端 composer 中打开 `@`、`$`、`/` 或 `、` 菜单后，移动光标或继续输入
查询内容时，菜单应跟随当前插入点。菜单优先显示在插入点下方；可见空间不足时
翻转到上方。切换菜单层级也不得把锚点改回整个 composer 输入框。菜单宽度仍受
输入区可用宽度约束。自动换行、输入框内部滚动、布局移动和缩放后的编辑容器
不能让菜单停留在旧的光标位置。若上下两侧都放不下完整菜单，菜单行仍应在
可见视口内通过滚动访问。

编辑并重发时的行内菜单采用同样的光标定位。在较窄的移动端视口，主 composer
继续使用靠近键盘停靠的 mention 面板；行内编辑器继续使用浮动菜单。停靠面板
位于包含输入框上方附件和控件的整个 composer 框之上，且不得越过视口顶部留白。

## 证据

- [菜单调用方](../packages/components/src/components/mentions/mention-two-level-menu.tsx)
- [光标锚点](../packages/components/src/ui/mention/mention-input.tsx)
- [行为测试](../packages/components/tests/mention-ref-stability.test.tsx)
- [移动端定位测试](../packages/components/tests/mention-two-level-menu.test.tsx)
