# 保持模型子菜单搜索框的焦点

Status: implemented
Translation: current

[English](2026-09-21-model-search-focus.md)

## 摘要

桌面模型搜索框最初能获得焦点，但鼠标继续在父菜单的「模型」行上移动或点击时，
焦点会回到该菜单行，导致键入内容没有进入搜索框。共享子菜单触发器现在把精确指针
交互交给自身已打开的搜索框，避免 Radix 重新聚焦触发器。浏览器回归测试覆盖打开、
继续移动鼠标、再次打开、过滤和键盘导航；触屏仍需主动点击搜索框。

## 原因与决定

`DropdownMenuSearchInput` 已经在精确指针设备上于挂载后自动聚焦。
Radix 的子菜单触发器却会在每次鼠标移动和点击时聚焦自身。悬停立即打开子菜单后，
搜索框可能先于鼠标在触发器上停止移动而挂载，因此增加挂载延迟只会改变竞争时机。

触发器通过 `aria-controls` 找到自己的内容，并且只在该内容直接拥有
`DropdownMenuSearchInput` 时接管焦点。禁用状态、调用方已阻止的事件、触屏设备
及普通子菜单保持既有行为。这次修复恢复原有搜索意图，不改变模型选择或 Provider
契约。[运行设置说明](../../../docs/sessions-run-config.md)维护实现概览；此前的
[子菜单布局决定](2026-09-15-menu-submenu-gap-and-viewport-margin.zh.md)与本修复独立。

## 验证证据

现有 Playwright
[composer 焦点测试](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
使用真实的 `ComposerRunConfigMenu/ModelSearch` story。修复前，两种鼠标路径在
继续移动到「模型」行时都无法通过焦点断言，键盘打开路径通过。修复后三种路径
均通过，包含再次打开和不点击搜索框就直接输入 `54m`。测试还覆盖方向下键进入
过滤结果及触屏主动聚焦。这是 renderer 浏览器测试，不是完整 Electron/CLI 旅程，
不使用模型服务或真实对话记录。
