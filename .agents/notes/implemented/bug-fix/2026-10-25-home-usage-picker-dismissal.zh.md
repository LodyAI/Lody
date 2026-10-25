# 首页用量 Provider 选择后关闭菜单

Status: implemented
Translation: current

PR: [#1882](https://github.com/LodyAI/Lody/pull/1882)

[English](2026-10-25-home-usage-picker-dismissal.md)

## 摘要

首页用量卡片的 Provider 选择菜单在选中后仍保持展开。
原因是单选菜单项沿用了 Base UI 默认不关闭菜单的行为。
现在每个菜单项都显式设置 `closeOnClick`，选择其他 Provider 或再次选择当前项都会关闭菜单。
修复仅作用于此选择器，保留共享菜单组件的默认设置。

## 决策与证据

[`UsageSourcePicker`](../../../../packages/components/src/components/chat/home/tiles.tsx)
通过 `Menu.RadioGroup` 管理选择，每个 Provider 使用 `Menu.RadioItem`。
[Base UI 契约](https://base-ui.com/react/components/menu#radio-item)
中 `closeOnClick` 默认为 `false`。每个菜单项通过此属性负责关闭，
无需额外控制菜单状态，也无需将关闭动作与选择回调绑定。
本记录补充[首页面板决策](../feature/2026-10-16-home-week-tiles.zh.md)。

## 验证与限制

现有[面板组件测试](../../../../packages/components/tests/home-dashboard-component.test.tsx)
新增真实菜单交互：保持当前选择和切换选择都会关闭菜单，并报告被点击的 Provider id。
Base UI 再次选择当前值时也会触发选择回调；CI 证明了最初认为此操作不触发回调的断言有误。
由于可用依赖树缺少 `@stylexjs/unplugin`，面板和周面板的定向测试无法启动。
尚未验证浏览器实际行为。
