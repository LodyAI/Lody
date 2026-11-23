# 菜单字重

Status: draft
Translation: current

[English](menu-typography.md)

## 场景

用户打开会话菜单或 composer 选择菜单，浏览其中的平级选项。
普通选项应在这些界面中保持相同的视觉优先级。

## 职责

菜单标签使用普通字重（400），包括子菜单、复选和单选项、右键菜单及菜单栏标签。
Composer 的选择菜单和 mention 菜单遵循相同规则。选中和悬停通过标记与背景表达；
选中某个选项不会加重它的标签。

分组标题可以保留中等字重（500），mention 搜索命中的字符保留强调。
按钮、字段触发器、搜索输入和浮层正文各自保留其文字角色。

共享菜单组件负责默认字重。自行渲染选择或 mention 行的 composer 样式负责相应声明，
不改变定位、行间距、键盘导航或选择行为。

## 证据

实现：[浮层样式](../packages/ui/src/popup/surface.ts)、
[composer 样式](../packages/components/src/components/shared/composer-surface.ts)、
[mention 样式](../packages/components/src/ui/mention/mention-surface.ts)。

决策与验证：
[菜单字重记录](../.agents/notes/implemented/bug-fix/2026-09-30-menu-regular-weight.zh.md)。
