# 在 badge token 模块内解析侧栏主题

Status: implemented
Translation: current

[English](2026-09-26-sidebar-badge-theme-resolution.md)

## 摘要

侧栏的 Mergeable 标签在 StyleX 开发态转换时会报「Only static values are allowed inside of a
createTheme() call」，即使两个覆盖值都改成字面量也仍会失败。StyleX 先解析变量组，
再解析覆盖值；跨包引入的 `badge` 是剩下最可能出错的输入。现在强调 success 的主题与 `badge`
一起定义在 `@lody/ui`，侧栏只重新导出主题，不再编译另一个 `createTheme` 调用。文字的
success 色和 16% 底色保持[阅读对比度决策](../feature/2026-09-24-reading-contrast.zh.md)。

## 决策与证据

`@lody/ui` 拥有 badge token 组，原本就在同一源文件创建它的配色主题。产品侧文件现在只为
Mergeable 行命名这个可选主题，变量组和覆盖值由同一模块编译。UI 展示板在普通色调旁展示
强调 success 的状态。

已安装的 StyleX Babel 插件会先计算 `createTheme` 的第一个参数，再计算覆盖对象；任一计算
无法确定时都会给出相同的静态值报错。底色已静态化、两个值都成为字面量后仍失败，说明这些
表达式并非唯一原因。改成相对路径直达源文件仍会让侧栏文件保留跨包 `createTheme`；将主题
移入 token 模块则去掉了侧栏转换对该解析的依赖。

## 验证与限制

Electron 渲染器生产构建编译了新主题，包括 16% 的 success 底色。在 Storybook token
展示板里，实际渲染的标签在两套配色中都有 16% 的底色和 success 文字色（浅色
`rgb(41, 142, 93)`，深色 `rgb(59, 206, 135)`）。UI 和 components 类型检查、UI
展示板与侧栏标签测试、公开仓库边界检查均通过。本检出环境没有安装 Electron 本体，
因此未运行完整的交互式桌面会话。
