# 保持 composer 模型与项目搜索框的焦点

Status: implemented
Translation: current

[English](2026-09-21-model-search-focus.md)

## 摘要

桌面模型与项目菜单中的搜索焦点可能被 Radix 菜单项抢走，导致键入内容没有进入
搜索框。模型子菜单触发器现在在指针交互期间保持自身搜索框的焦点；项目选择器则
复用共享菜单搜索控件，在项目行获得焦点后把键入内容交回搜索框。初始聚焦由已挂载
的输入框负责，不再依赖挂载前的打开回调。浏览器回归覆盖打开、指针移动、再次打开、
过滤和键盘导航；共享控件在触屏上仍需主动点击激活。

## 原因与决定

`DropdownMenuSearchInput` 已经在精确指针设备上于挂载后自动聚焦。
Radix 的子菜单触发器却会在每次鼠标移动和点击时聚焦自身。悬停立即打开子菜单后，
搜索框可能先于鼠标在触发器上停止移动而挂载，因此增加挂载延迟只会改变竞争时机。

触发器通过 `aria-controls` 找到自己的内容，并且只在该内容直接拥有
`DropdownMenuSearchInput` 时接管焦点。禁用状态、调用方已阻止的事件、触屏设备
及普通子菜单保持既有行为。这次修复恢复原有搜索意图，不改变模型选择或 Provider
契约。[运行设置说明](../../../docs/sessions-run-config.md)维护实现概览；此前的
[子菜单布局决定](2026-09-15-menu-submenu-gap-and-viewport-margin.zh.md)与本修复独立。

项目选择器原先使用普通 `Input`，在 `onOpenChange` 中、输入框挂载前调度聚焦。
它的键盘处理只能保护已经聚焦的输入框：悬停项目行后，焦点移走，后续键入进入
Radix 菜单快捷搜索。复用 `DropdownMenuSearchInput` 后，自动聚焦由控件挂载负责，
并复用从列表行恢复键入及方向键导航的能力，无需新增焦点监听器。项目匹配、最近使用
排序、选择和渲染上限仍由 `UnifiedProjectSelectorView` 负责。

## 验证证据

现有 Playwright
[composer 焦点测试](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
使用真实的 `ComposerRunConfigMenu/ModelSearch` 和
`UnifiedProjectSelector/SelectedPrivate` story。修复前，两种鼠标路径在
继续移动到「模型」行时都无法通过焦点断言，键盘打开路径通过。修复后三种路径
均通过，包含再次打开和不点击搜索框就直接输入 `54m`。测试还覆盖方向下键进入
过滤结果及触屏主动聚焦。两条项目测试在修复前均因悬停项目行后无法键入搜索框而失败，
修复后六条浏览器用例全部通过；项目测试也验证再次打开时清空查询并能直接输入过滤。这是 renderer 浏览器测试，不是完整 Electron/CLI 旅程，
不使用模型服务或真实对话记录。

PR：[#864](https://github.com/LodyAI/Lody/pull/864)。
