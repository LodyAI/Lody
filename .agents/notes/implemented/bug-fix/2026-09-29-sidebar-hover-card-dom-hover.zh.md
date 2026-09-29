# 侧边栏悬停卡按 DOM 判定悬停

Status: implemented
Translation: current

[English](2026-09-29-sidebar-hover-card-dom-hover.md)

## 摘要

侧边栏筛选菜单打开时，第一个机器分组的机器卡会盖在菜单上，指针在两者之间移动时来回闪烁（[#1105](https://github.com/LodyAI/Lody/issues/1105)）。菜单通过 portal 渲染，但在 React 树里它是机器标题的后代，而机器标题正是悬停卡的触发器。React 的指针 enter/leave 按 React 树计算，所以指针在菜单里等于在标题上。共享的 `SidebarHoverCard` 现在用原生 DOM 监听判定悬停；触发器内部有弹出层打开时，卡片也不会打开。这两处改动都没有新增 API，侧边栏也不需要多传状态。

## 问题

`SidebarFilterPopover` 以内联方式画在第一个分组标题的 `action` 里（[内联触发器](2026-09-22-sidebar-filter-trigger-in-flow.md)）。这个标题外面包着 `SidebarMachineHoverCard`，也就是 `SidebarHoverCard`。触发器原来用 React 的 `onPointerEnter`、`onPointerLeave` 和 `onPointerDown` 监听。React 按组件树生成 enter/leave，portal 里的事件也会传给它在 React 树里的祖先。筛选菜单虽然渲染到别处，仍是触发器 `div` 的 React 子节点。结果是：

- 指针从机器名移进菜单时没有 leave，预热不会被取消，约 650ms 后卡片盖在菜单上打开；如果还在预热窗口内，则立即打开；
- 从别处直接进入菜单，也算进入了标题；
- 在菜单里按下，也算在标题上按下。

issue 里说的 180ms 关闭宽限，在指针从标题移到菜单时并不会启动：在 React 看来，这一步从未离开触发器。

同一个外壳也包着会话行。会话行通过 portal 渲染的右键菜单，同样位于行的 React 树里。

## 决策

- **悬停以 DOM 为准。** `SidebarHoverCard` 在触发器元素上挂原生的 `pointerenter`、`pointerleave` 和 `pointerdown` 监听。原生事件沿 DOM 传播，portal 出去的后代就在触发器之外。卡片本身仍用 React 监听：卡片里打开的弹出层让卡片保持打开，这里正需要按 React 树计算。
- **触发器自己打开的弹出层优先。** 触发器内若有元素同时带 `aria-haspopup` 和 `aria-expanded="true"`，悬停不会打开卡片。Base UI 的 popover 和 menu 触发器打开时会同时设置这两个属性。可折叠分组的开关只有 `aria-expanded`，tooltip 触发器两者都没有，所以它们都不会挡住卡片。用鼠标打开菜单时，按下抑制已经关掉了卡片，所以只需在打开路径上检查。

否决的方案：

- **由侧边栏把 `sidebarFilterOpen` 作为 `blocked` prop 传进来。** 它只在一个调用点掩盖症状，其他悬停卡的 portal 问题依旧；侧边栏得了解卡片的规则；`blocked` 还和近义的 `disabled` 并存。
- **悬停卡只包住机器名。** 这要改标题的 API，而且会话行的触发器里仍有 portal 出去的右键菜单。
- **提高筛选菜单的叠放层级。** 卡片仍会在指针下方挂载。

## 验证

- `packages/components/tests/sidebar-machine-card.test.tsx` 渲染真实组合：机器卡包着一个展开的分组标题，标题的 action 是真实的 `SidebarFilterPopover`。菜单打开时，在机器名上停留再移进菜单，卡片都保持关闭。菜单关闭后，悬停能打开卡片，即使标题开关仍是 `aria-expanded="true"`。
- `packages/components/tests/session-info-hover-card.test.tsx` 给触发器加了一个 portal 子节点：移进它会取消预热，直接进入它不会打开卡片，在它里面按下不会抑制触发器。
- `tests/helpers/pointer-boundary.ts` 按浏览器在指针移动时发送的顺序触发事件：先 over/out，再在每个 DOM 祖先上触发 enter/leave。jsdom 不会从一组事件推出另一组，所以这些测试同时覆盖 React 监听和原生监听。
- 没有在真实 Electron 会话里验证。jsdom 不会绘制两个 portal 弹出层的重叠。
