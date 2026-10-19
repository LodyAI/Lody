# 导航侧栏收起时的定时任务页顶栏

Status: implemented
Translation: current

[English](2026-10-09-schedules-sidebar-toggle-traffic-lights.md)

## 摘要

左侧导航侧栏收起后，桌面端定时任务页没有展开按钮，标题还会压在 macOS 红绿灯下。
列表现在在标题行放入与 Chat Landing、归档页相同的 PanelLeft 展开控件；在 macOS
Electron 上把该行内缩到 96px，让标题让开灯簇。移动端仍用自己的首页顶栏，不加这
个桌面控件。

## 决策

采用归档页把按钮放进标题行的做法，而不是 Chat Landing 的绝对定位浮层：定时任务
页已有 44px 标题行，展开按钮应在这一行里。水平内缩与 Chat Landing 一致（左边距
100px，按钮再 −4px，落在 96px，灯簇右缘 x=76 后再空 24px）。垂直对齐使用共用的
macOS 红绿灯行垫和 Windows 标题按钮行垫。列表自己读取
`navigationSidebarVisibleAtom`，因为内缩和按钮是同一套标题布局。

未采用：在标题行上再叠一层 Chat Landing 浮层（左侧会有两套控件）；以及侧栏收起
后仍把标题留在 16px 边距。

## 验证

`schedule-list` 测试覆盖侧栏显隐、移动端不出现、点击展开，以及 macOS 内缩标记；
本工作树中 10 项通过。Storybook 增加 `SidebarHidden` 与
`SidebarHiddenBesideTrafficLights`。不把示意灯当作已打包 Electron 真灯的验证。
嵌套工作树通过兄弟目录链接 `node_modules` 启动的 Storybook 未能完成渲染
（`@lody/ui` 导出扫描失败），因此 iframe 截图不能作为依据。
