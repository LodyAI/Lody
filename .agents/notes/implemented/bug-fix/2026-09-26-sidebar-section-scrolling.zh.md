# 侧栏分组标题随列表滚动

Status: implemented
Translation: current

[English](2026-09-26-sidebar-section-scrolling.md)

## 摘要

侧栏吸顶标签可能在滚动时与项目行重叠。按用户要求，分组标题现在保持普通文档流，
随所属行一起滚出视口。这样不再需要覆盖行的标题层，代价是长分组滚动后不再持续
显示机器名。当前检出目录尚未完成浏览器验证。

## 决策

本次替代了[标题背景修复](2026-09-26-sticky-sidebar-group-header-background.zh.md)
保留的吸顶行为，该行为最初来自
[分组标签设计](../feature/2026-09-25-deep-sea-palette-and-sidebar-groups.zh.md)。
背景修正仍有历史参考价值，但让覆盖层不透明不符合本次要求的滚动行为。

删除共享吸顶容器常量及机器、Chats 标题中的使用，保留控件与尺寸，并调整现有
Storybook 滚动场景。当前产品意图见
[Spec](../../../../specs/sidebar-section-scrolling.zh.md)。

## 验证限制

已检查两处生产标题路径与场景代码。当前检出目录未安装依赖，尚未验证组件类型检查
和浏览器运行。本次 CSS 删除未新增自动化测试。
