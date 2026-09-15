# 让下拉子菜单既不贴屏幕边缘，也不贴住父菜单

Status: implemented
Translation: current

[English](2026-09-15-menu-submenu-gap-and-viewport-margin.md)

## 摘要

输入框运行配置菜单里的子菜单——其中最高的模型列表——会直接贴在窗口底部，并且和父菜单右边缘焊在一起，两个面板之间看不到任何缝隙。两个症状同源：`DropdownMenuSubContent` 把 Radix 的 `collisionPadding` 留在默认值 0，而它的 `sideOffset: 6` 是从触发行而不是父面板边缘量起的。修复把顶层菜单早就有的、含安全区的碰撞内边距同样给到每个子菜单，并抽成共享的 `useSafeAreaCollisionPadding`；同时把子菜单偏移提到 10，让两个面板分开。在 Chromium 900×470 视口实测：底部留白从 0px 变为 8px，面板间距从 2px 变为 6px。这个偏移是按当前面板内边距与 1px 描边调出来的固定数值，并非由它们推导，所以改动其中任何一项都会再次悄悄吃掉缝隙。

## 每个症状的真正成因

`DropdownMenuContent` 从一开始就把设备安全区并进了 8px 的 `collisionPadding`，而 `DropdownMenuSubContent` 从未这样做，于是 Radix 采用其文档中的默认值 0。floating-ui 的 `detectOverflow` 读的正是这个内边距，Radix 又用同一次计算导出 `--radix-dropdown-menu-content-available-height`——因此高度超过触发行下方空间的子菜单，既被*推*到视口边缘，又被*限高*到那里。模型子菜单用 `min(20rem, var(--radix-dropdown-menu-content-available-height))` 自限高度，这正是它成为可见案例的原因：它是唯一长到会发生碰撞的那个。

缝隙消失则是算术问题，与碰撞无关。`sideOffset` 是相对锚点的偏移，而子菜单的锚点是 `SubTrigger` 行，它位于父面板 `p-1` 之内；`menuSurfaceStyle` 又用 `0 0 0 1px` 把每个面板的描边画在其 border box **之外**。于是可见间距为 `6 − 4（内边距）− 1 − 1（两条描边）= 0px`，两个菜单看起来就是一整块。对照用户提供的截图按其 2 倍缩放逐像素核对：2px 的盒间距恰好被两条描边填满（4 个设备像素，每条 2 个），中间没有任何一列背景色。

## 验证与局限

- 在真实 Chromium 中复现并验证：用一次性 Vite 页面渲染真正的 `DropdownMenu` 原语，视口 900×470，子菜单高到足以碰撞。修复前 `底部留白 0px`、`间距 2px`、`--radix-popper-available-height: 470px`（整个视口）；修复后 `底部留白 8px`、`间距 6px`、`available-height 454px`。
- `tests/session-switch-render-cost.test.tsx` 直接覆盖 `useSafeAreaCollisionPadding`：8px 下限、安全区叠加，以及调用方更大的单边取值胜出。`tests/dropdown-menu.test.tsx` 仍然通过，它断言的是焦点与展开状态行为，本次未触及。
- jsdom 不做布局，因此没有测试断言最终几何。上面的 8px/6px 依据的是浏览器实测，而非测试套件。
- `PopoverContent` 与 `DropdownMenuContent` 各自持有一份合并逻辑副本，现在都改为调用共享 hook。这是无行为变化的重构——该 hook 与原先逐边 `Math.max` 完全等价。
- 只修复了 `ui/dropdown-menu.tsx`。`ui/context-menu.tsx` 与 `ui/menubar.tsx` 包装的是不同的 Radix 原语，仍未传 `collisionPadding`；它们不在本次缺陷范围内，也未做检查。
