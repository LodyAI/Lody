# 在无过渡的情况下解析终端颜色

Status: proposed
Translation: current

[English](2026-09-09-terminal-reduced-motion-colors.md)

## 摘要

启用 reduced motion 时，终端的同步 CSS 颜色探测可能把背景色当作前景色、光标色与 ANSI 调色板返回，
使一个正常工作的终端看起来一片空白。本补丁在一次性探测元素进入文档之前禁用其过渡。Chromium 在
未改动的解析器上复现了该失败，在打上补丁后于两种 motion 模式下均通过，包括一次深色到浅色的调色板
切换。全局无障碍样式与终端生命周期保持不变。

## 决策

`buildTerminalTheme` 拥有终端创建与主题更新两条路径上的「CSS 到 xterm」颜色解析。全局 reduced-motion
规则会为每个元素设置非零的 `transition-duration`，而探测元素默认的过渡属性是 `all`。因此每次即时
读取计算样式，都可能观察到一次颜色过渡的起点，而不是所请求的 token。

在把探测元素 append 进文档之前，把它的 `transitionProperty` 设为 `none`。修改全局 reduced-motion
规则会影响无关组件，而等待过渡完成则会把一个同步解析器变成异步的。

## 证据与限制

Playwright 回归通过既有的 Storybook 服务使用真实样式表与解析器，并使用合成 CSS token。它在
`reduce` 与 `no-preference` 下检查前景色、光标色、红/绿 ANSI 颜色、带 alpha 的选区颜色、一次调色板
切换以及探测元素的清理。

打补丁之前只有 reduced-motion 用例失败；打补丁之后两个用例都通过。这是 Chromium 渲染层验证，不是
重新构建的桌面版本，也不是对每个终端渲染器与操作系统的验证。

在 Node 22.22.2 下 `pnpm check` 通过，包含既有的组件套件。`pnpm format` 与 `pnpm run docs check`
通过；无关的格式化输出已从补丁中排除，保留了解析器既有的格式。
